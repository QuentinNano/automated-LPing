import { describe, expect, it } from "vitest";
import type { HistoryTimeframe, PoolCandle } from "@lping/core";
import {
  formatHistoryStats,
  parseTimeframe,
  runBackfill,
  type BackfillDeps,
  type BackfillStore,
} from "../src/backfill";

const NOW = new Date("2026-07-29T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

class FakeStore implements BackfillStore {
  pools: { poolAddress: string; firstSeenAt: Date }[] = [];
  newest = new Map<string, Date>();
  recorded: PoolCandle[] = [];
  /** Wurde `activeOnly` durchgereicht? */
  lastOptions: { activeOnly?: boolean; limit?: number } | undefined;

  async trackedPools(options?: { activeOnly?: boolean; limit?: number }) {
    this.lastOptions = options;
    const limit = options?.limit;
    return limit === undefined ? this.pools : this.pools.slice(0, limit);
  }
  async newestCandleAt() {
    return this.newest;
  }
  async recordCandles(candles: PoolCandle[]) {
    this.recorded.push(...candles);
    return candles.length;
  }
}

interface Request {
  poolAddress: string;
  timeframe: HistoryTimeframe;
  startTime: Date;
  endTime: Date;
}

function deps(
  store: FakeStore,
  getHistory?: BackfillDeps["getHistory"],
): { deps: BackfillDeps; requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    deps: {
      store,
      now: () => NOW,
      getHistory:
        getHistory ??
        (async (poolAddress, query) => {
          requests.push({ poolAddress, ...query });
          return [candle(poolAddress, query.startTime, query.timeframe)];
        }),
    },
  };
}

function candle(poolAddress: string, ts: Date, timeframe: HistoryTimeframe): PoolCandle {
  return {
    poolAddress,
    ts,
    timeframe,
    open: 1,
    high: 1.2,
    low: 0.8,
    close: 1.1,
    volumeUsd: 1000,
    feesUsd: 15,
    protocolFeesUsd: 1.5,
  };
}

describe("runBackfill", () => {
  it("holt einem neu entdeckten Pool seine Vorgeschichte", async () => {
    // Der eigentliche Gewinn: Ein Pool, der bei der Entdeckung schon existierte,
    // liefert sofort Verlauf — Material, das früher unerreichbar war.
    const store = new FakeStore();
    store.pools = [{ poolAddress: "PoolA", firstSeenAt: hoursAgo(2) }];
    const { deps: d, requests } = deps(store);

    const result = await runBackfill(d, { lookbackHours: 24, chunkHours: 24 });

    expect(result.pools).toBe(1);
    expect(requests).toHaveLength(2);
    // Ab 26 Stunden vor jetzt (2 h Alter + 24 h Rückblick), in 24-Stunden-Stücken.
    expect(requests[0]!.startTime).toEqual(hoursAgo(26));
    expect(requests[0]!.endTime).toEqual(hoursAgo(2));
    expect(requests[1]!.endTime).toEqual(NOW);
  });

  it("setzt an der jüngsten vorhandenen Kerze fort, statt alles neu zu holen", async () => {
    const store = new FakeStore();
    store.pools = [{ poolAddress: "PoolA", firstSeenAt: hoursAgo(100) }];
    store.newest = new Map([["PoolA", hoursAgo(3)]]);
    const { deps: d, requests } = deps(store);

    await runBackfill(d, { lookbackHours: 168, chunkHours: 24 });

    expect(requests).toHaveLength(1);
    // Die letzte Kerze wird erneut geholt: Beim vorigen Lauf war sie noch offen.
    expect(requests[0]!.startTime).toEqual(hoursAgo(3));
  });

  it("überspringt Pools, deren Historie aktuell ist", async () => {
    const store = new FakeStore();
    store.pools = [{ poolAddress: "PoolA", firstSeenAt: hoursAgo(50) }];
    // Jünger als eine Fensterlänge → es gibt nichts Neues.
    store.newest = new Map([["PoolA", new Date(NOW.getTime() - 60_000)]]);
    const { deps: d, requests } = deps(store);

    const result = await runBackfill(d, { timeframe: "5m" });

    expect(requests).toHaveLength(0);
    expect(result.upToDate).toBe(1);
    expect(result.pools).toBe(0);
  });

  it("ein Pool ohne Historie stoppt den Lauf nicht", async () => {
    const store = new FakeStore();
    store.pools = [
      { poolAddress: "PoolA", firstSeenAt: hoursAgo(1) },
      { poolAddress: "Weg", firstSeenAt: hoursAgo(1) },
      { poolAddress: "PoolC", firstSeenAt: hoursAgo(1) },
    ];
    const { deps: d } = deps(store, async (poolAddress, query) => {
      if (poolAddress === "Weg") throw new Error("Pool entfernt");
      return [candle(poolAddress, query.startTime, query.timeframe)];
    });

    const result = await runBackfill(d, { lookbackHours: 2, chunkHours: 24 });

    expect(result.pools).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.notes.join(" ")).toContain("Pool entfernt");
    expect(store.recorded.map((c) => c.poolAddress)).toEqual(["PoolA", "PoolC"]);
  });

  it("teilt lange Zeiträume in Stücke, statt eine Riesenantwort zu erwarten", async () => {
    const store = new FakeStore();
    store.pools = [{ poolAddress: "PoolA", firstSeenAt: NOW }];
    const { deps: d, requests } = deps(store);

    await runBackfill(d, { lookbackHours: 72, chunkHours: 24 });

    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.endTime.getTime() - r.startTime.getTime())).toEqual([
      24 * 3_600_000,
      24 * 3_600_000,
      24 * 3_600_000,
    ]);
  });

  it("reicht Begrenzung und Aktiv-Filter an den Bestand durch", async () => {
    const store = new FakeStore();
    store.pools = [
      { poolAddress: "PoolA", firstSeenAt: hoursAgo(1) },
      { poolAddress: "PoolB", firstSeenAt: hoursAgo(1) },
    ];
    const { deps: d } = deps(store);

    await runBackfill(d, { limit: 1, activeOnly: true, lookbackHours: 2 });

    expect(store.lastOptions).toEqual({ activeOnly: true, limit: 1 });
    expect(store.recorded.map((c) => c.poolAddress)).toEqual(["PoolA"]);
  });

  it("meldet einen leeren Bestand, statt Anfragen zu stellen", async () => {
    const store = new FakeStore();
    const { deps: d, requests } = deps(store);

    const result = await runBackfill(d);

    expect(requests).toHaveLength(0);
    expect(result).toMatchObject({ pools: 0, candles: 0, failed: 0 });
  });
});

describe("parseTimeframe", () => {
  it("nimmt die dokumentierten Fensterlängen an", () => {
    expect(parseTimeframe("1h")).toBe("1h");
    expect(parseTimeframe(undefined)).toBe("5m");
  });

  it("weist alles andere mit den erlaubten Werten zurück", () => {
    expect(() => parseTimeframe("7m")).toThrow(/Erlaubt/);
  });
});

describe("formatHistoryStats", () => {
  it("verweist auf das Kommando, wenn noch nichts nachgeladen ist", () => {
    const text = formatHistoryStats({ pools: 0, candles: 0, firstAt: null, lastAt: null });
    expect(text).toContain("nachladen");
  });

  it("weist Zeitraum und Dichte aus", () => {
    const text = formatHistoryStats({
      pools: 10,
      candles: 2880,
      firstAt: hoursAgo(24),
      lastAt: NOW,
    });
    expect(text).toContain("2880 Kerzen für 10 Pools");
    expect(text).toContain("1.0 Tage");
    expect(text).toContain("288 Kerzen je Pool");
  });
});
