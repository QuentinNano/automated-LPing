import { describe, expect, it } from "vitest";
import { WSOL_MINT, type ReplayPool, type TrackPoint } from "@lping/core";
import { formatReplayResult, runReplay, type ReplayDeps, type ReplayStore } from "../src/replay";
import { loadDefaultConfig, TOKEN_MINT } from "../../../packages/core/test/builders";

const NOW = new Date("2026-07-29T12:00:00Z");
const config = loadDefaultConfig();

const poolA: ReplayPool = {
  poolAddress: "PoolA",
  mintX: TOKEN_MINT,
  mintY: WSOL_MINT,
  binStep: 100,
};

function series(count: number, startMinutesAgo = 600): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(NOW.getTime() - (startMinutesAgo - i * 5) * 60_000),
    priceNative: 0.001,
    tvlUsd: 250_000,
    fees24hUsd: 12_500,
    volume24hUsd: 1_250_000,
    dynamicFeePct: 1.4,
    baseFeePct: 1,
    protocolFeePct: 10,
    solPriceUsd: 180,
    windows: null,
  }));
}

class FakeStore implements ReplayStore {
  pools: ReplayPool[] = [poolA];
  bySeries = new Map<string, TrackPoint[]>([["PoolA", series(120)]]);
  requested: string[] = [];

  async replayPools(poolAddresses?: string[]) {
    return poolAddresses === undefined
      ? this.pools
      : this.pools.filter((pool) => poolAddresses.includes(pool.poolAddress));
  }
  async loadSeries(poolAddress: string) {
    this.requested.push(poolAddress);
    return this.bySeries.get(poolAddress) ?? [];
  }
}

function deps(store: ReplayStore): ReplayDeps {
  return { store, now: () => NOW };
}

describe("runReplay", () => {
  it("spielt jedes Preset auf demselben Verlauf ab", () => {
    // Der Grund für den gemeinsamen Verlauf: Unterschiede zwischen den Presets
    // dürfen nur aus den Parametern stammen, nicht aus verschiedenen Daten.
    const store = new FakeStore();
    return runReplay(deps(store), config).then((result) => {
      expect(result.byPreset).toHaveLength(3);
      expect(result.pools).toBe(1);
      // Ein Ladevorgang je Pool, nicht je Preset.
      expect(store.requested).toEqual(["PoolA"]);
      expect(result.byPreset.every((row) => row.summary.positions > 0)).toBe(true);
    });
  });

  it("überspringt Pools ohne verwertbaren Verlauf und sagt warum", async () => {
    const store = new FakeStore();
    store.pools = [poolA, { ...poolA, poolAddress: "Leer" }];
    store.bySeries.set("Leer", []);

    const result = await runReplay(deps(store), config);

    expect(result.pools).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.notes.join(" ")).toContain("nachladen");
  });

  it("erklärt einen leeren Bestand, statt eine leere Tabelle zu zeigen", async () => {
    const store = new FakeStore();
    store.pools = [];

    const result = await runReplay(deps(store), config);

    expect(result.byPreset).toHaveLength(0);
    expect(result.notes.join(" ")).toContain("Stammdaten");
    expect(formatReplayResult(result)).toContain("aufzeichnen");
  });

  it("grenzt auf einen einzelnen Pool ein", async () => {
    const store = new FakeStore();
    store.pools = [poolA, { ...poolA, poolAddress: "PoolB" }];
    store.bySeries.set("PoolB", series(120));

    const result = await runReplay(deps(store), config, { pools: ["PoolB"] });

    expect(store.requested).toEqual(["PoolB"]);
    expect(result.pools).toBe(1);
  });

  it("reicht den Einstiegsabstand durch", async () => {
    const store = new FakeStore();
    const dense = await runReplay(deps(store), config, { everyMinutes: 15 });
    const sparse = await runReplay(deps(store), config, { everyMinutes: 120 });

    const count = (r: Awaited<ReturnType<typeof runReplay>>) =>
      r.byPreset.reduce((sum, row) => sum + row.summary.positions, 0);
    expect(count(dense)).toBeGreaterThan(count(sparse));
  });
});

describe("formatReplayResult", () => {
  it("weist zensierte Positionen als solche aus", async () => {
    const result = await runReplay(deps(new FakeStore()), config);
    const text = formatReplayResult(result);

    expect(text).toContain("vs HODL");
    expect(text).toContain("noch offen");
    expect(text).toContain("nicht in Trefferquote");
  });

  it("warnt bei zu wenigen abgeschlossenen Positionen", async () => {
    const store = new FakeStore();
    store.bySeries.set("PoolA", series(20));
    const text = formatReplayResult(await runReplay(deps(store), config));

    expect(text).toContain("zu wenig für eine Aussage");
  });

  it("zeigt die Ausstiegsgründe, damit eine Zahl deutbar wird", async () => {
    const store = new FakeStore();
    // Lang genug, dass das Degen-Zeitlimit (24 h) greift.
    store.bySeries.set("PoolA", series(400, 2000));
    const text = formatReplayResult(await runReplay(deps(store), config));

    expect(text).toContain("max_hold_time");
  });
});
