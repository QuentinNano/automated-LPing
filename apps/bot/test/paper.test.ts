import { describe, expect, it } from "vitest";
import {
  openPaperPosition,
  positionSizeSol,
  valuePosition,
  type PaperPositionState,
  type PoolMetrics,
  type PresetKind,
  type PresetPerformance,
} from "@lping/core";
import { formatComparison, openFromScan, tickOpenPositions, type PaperDeps, type PaperStore } from "../src/paper";
import type { ScanRow } from "../src/scan";
import { buildPool, loadDefaultConfig, TOKEN_MINT } from "../../../packages/core/test/builders";

const config = loadDefaultConfig();
const T0 = new Date("2026-07-29T12:00:00Z");

interface StoredPosition {
  id: string;
  poolAddress: string;
  preset: string;
  simState: PaperPositionState;
  closed: boolean;
  realizedPnlSol: number;
  reason: string | null;
}

/** In-Memory-Store: bildet die Semantik von PaperRepo ohne DB ab. */
class FakeStore implements PaperStore {
  readonly positions: StoredPosition[] = [];
  private seq = 0;

  async open(record: Parameters<PaperStore["open"]>[0]): Promise<string> {
    const id = `pos-${++this.seq}`;
    this.positions.push({
      id,
      poolAddress: record.poolAddress,
      preset: record.preset,
      simState: record.state,
      closed: false,
      realizedPnlSol: 0,
      reason: null,
    });
    return id;
  }

  async tick(record: Parameters<PaperStore["tick"]>[0]): Promise<void> {
    const position = this.positions.find((p) => p.id === record.positionId);
    if (position !== undefined) position.simState = record.state;
  }

  async close(record: Parameters<PaperStore["close"]>[0]): Promise<void> {
    const position = this.positions.find((p) => p.id === record.positionId);
    if (position !== undefined) {
      position.simState = record.state;
      position.closed = true;
      position.realizedPnlSol = record.realizedPnlSol;
      position.reason = record.reason;
    }
  }

  async listOpen(preset?: PresetKind) {
    return this.positions
      .filter((p) => !p.closed && (preset === undefined || p.preset === preset))
      .map((p) => ({ id: p.id, poolAddress: p.poolAddress, preset: p.preset, simState: p.simState }));
  }

  async countOpen(preset: PresetKind): Promise<number> {
    return this.positions.filter((p) => !p.closed && p.preset === preset).length;
  }

  async hasOpenFor(preset: PresetKind, poolAddress: string): Promise<boolean> {
    return this.positions.some((p) => !p.closed && p.preset === preset && p.poolAddress === poolAddress);
  }

  async performance(): Promise<PresetPerformance[]> {
    return [];
  }
}

function acceptedRow(preset: PresetKind, pool: PoolMetrics = buildPool()): ScanRow {
  return {
    preset,
    pool,
    tokenMint: TOKEN_MINT,
    volatilityPctDaily: 30,
    screening: {
      verdict: "accepted",
      checks: [],
      rejectedBy: [],
      score: { total: 80, components: [] },
      screenedAt: T0,
    },
  };
}

function buildDeps(store: FakeStore, pool: PoolMetrics = buildPool(), now = T0): PaperDeps {
  return {
    store,
    getPool: async () => pool,
    getSolPriceUsd: async () => 180,
    now: () => now,
  };
}

describe("openFromScan", () => {
  it("eröffnet je Preset eine Position auf identischen Kandidaten", async () => {
    const store = new FakeStore();
    const rows = [acceptedRow("degen"), acceptedRow("balanced"), acceptedRow("konservativ")];

    const result = await openFromScan(buildDeps(store), config, rows);

    expect(result.opened).toBe(3);
    expect(store.positions.map((p) => p.preset).sort()).toEqual([
      "balanced",
      "degen",
      "konservativ",
    ]);
  });

  it("nimmt die Positionsgröße aus der einen Quelle, die sie definiert", async () => {
    const store = new FakeStore();
    await openFromScan(buildDeps(store), config, [acceptedRow("degen")]);
    // Absolut in SOL statt als Anteil: Vorher rechneten Screening-Filter und
    // Engine mit unterschiedlichen Bezugsgrößen und kamen auf Faktor 2
    // Unterschied (ANALYSE.md 4.2).
    expect(store.positions[0]!.simState.depositSol).toBeCloseTo(
      positionSizeSol(config.presets["degen"]!),
    );
    expect(store.positions[0]!.simState.depositSol).toBe(1);
  });

  it("ignoriert abgelehnte Kandidaten", async () => {
    const store = new FakeStore();
    const rejected: ScanRow = {
      ...acceptedRow("degen"),
      screening: {
        verdict: "rejected",
        checks: [],
        rejectedBy: ["token_age"],
        score: { total: 80, components: [] },
        screenedAt: T0,
      },
    };
    const result = await openFromScan(buildDeps(store), config, [rejected]);
    expect(result.opened).toBe(0);
  });

  it("öffnet keine zweite Position im selben Pool je Preset", async () => {
    const store = new FakeStore();
    await openFromScan(buildDeps(store), config, [acceptedRow("degen")]);
    const again = await openFromScan(buildDeps(store), config, [acceptedRow("degen")]);
    expect(again.opened).toBe(0);
    expect(store.positions).toHaveLength(1);
  });

  it("respektiert das Positions-Limit des Presets", async () => {
    const store = new FakeStore();
    const rows = Array.from({ length: 8 }, (_, i) =>
      acceptedRow("degen", buildPool({ poolAddress: `Pool${i}`.padEnd(32, "x") })),
    );
    const result = await openFromScan(buildDeps(store), config, rows);
    expect(result.opened).toBe(config.presets["degen"]!.maxPositions);
    expect(result.notes.join(" ")).toContain("Positions-Limit");
  });

  it("eröffnet nichts, solange der Kill-Switch nicht auf 'off' steht", async () => {
    for (const killSwitch of ["pause", "flatten"] as const) {
      const store = new FakeStore();
      const result = await openFromScan(
        buildDeps(store),
        { ...config, global: { ...config.global, killSwitch } },
        [acceptedRow("degen"), acceptedRow("balanced")],
      );
      expect(result.opened).toBe(0);
      expect(store.positions).toHaveLength(0);
      expect(result.notes.join(" ")).toContain("killSwitch");
    }
  });

  it("lässt die Wallet-Grenzen im Paper-Betrieb nicht binden", async () => {
    // Die Presets sind eigenständige Experimente mit eigenem virtuellem
    // Kapital. Eine gemeinsame Obergrenze, die hier bindet, gäbe dem zuerst
    // gescannten Preset seine Positionen und dem letzten keine — gemessen würde
    // Reihenfolge statt Strategie.
    const store = new FakeStore();
    const eng = {
      ...config,
      global: { ...config.global, maxOpenPositions: 1, maxTotalExposureSol: 1 },
    };
    const result = await openFromScan(buildDeps(store), eng, [
      acceptedRow("degen"),
      acceptedRow("balanced"),
      acceptedRow("konservativ"),
    ]);
    expect(result.opened).toBe(3);
  });

  it("setzt die Wallet-Grenzen durch, sobald paperTrading aus ist", async () => {
    const store = new FakeStore();
    const live = {
      ...config,
      global: { ...config.global, paperTrading: false, maxOpenPositions: 2 },
    };
    const result = await openFromScan(buildDeps(store), live, [
      acceptedRow("degen"),
      acceptedRow("balanced"),
      acceptedRow("konservativ"),
    ]);
    expect(result.opened).toBe(2);
    expect(result.notes.join(" ")).toContain("globales Positions-Limit");
  });

  it("begrenzt live auch den Gesamteinsatz, nicht nur die Zahl der Positionen", async () => {
    const store = new FakeStore();
    // Degen setzt 1 SOL, Konservativ 5 — nach dem ersten Degen-Einstieg ist bei
    // 2 SOL Grenze für Konservativ kein Platz mehr.
    const live = {
      ...config,
      global: { ...config.global, paperTrading: false, maxTotalExposureSol: 2 },
    };
    const result = await openFromScan(buildDeps(store), live, [
      acceptedRow("degen"),
      acceptedRow("konservativ"),
    ]);
    expect(result.opened).toBe(1);
    expect(store.positions[0]!.preset).toBe("degen");
    expect(result.notes.join(" ")).toContain("globales Einsatz-Limit");
  });
});

describe("tickOpenPositions", () => {
  it("aktualisiert offene Positionen mit frischen Marktdaten", async () => {
    const store = new FakeStore();
    await openFromScan(buildDeps(store), config, [acceptedRow("degen")]);

    const later = new Date(T0.getTime() + 3_600_000);
    // Preis fällt leicht in die Range → Fees fließen.
    const pool = buildPool({ priceNative: 0.0000214 * 0.97 });
    const result = await tickOpenPositions(buildDeps(store, pool, later), config);

    expect(result.ticked).toBe(1);
    expect(result.closed).toBe(0);
    expect(store.positions[0]!.simState.feesUnclaimedSol).toBeGreaterThan(0);
  });

  it("schließt Positionen bei Stop-Loss und schreibt den Grund fest", async () => {
    const store = new FakeStore();
    await openFromScan(buildDeps(store), config, [acceptedRow("degen")]);

    const later = new Date(T0.getTime() + 3_600_000);
    const crashed = buildPool({ priceNative: 0.0000214 * 0.4 });
    const result = await tickOpenPositions(buildDeps(store, crashed, later), config);

    expect(result.closed).toBe(1);
    expect(store.positions[0]!.closed).toBe(true);
    expect(store.positions[0]!.reason).toBe("stop_loss");
    expect(store.positions[0]!.realizedPnlSol).toBeLessThan(0);
  });

  it("überspringt Positionen, deren Pool nicht abrufbar ist", async () => {
    const store = new FakeStore();
    await openFromScan(buildDeps(store), config, [acceptedRow("degen")]);

    const deps: PaperDeps = {
      ...buildDeps(store),
      getPool: async () => {
        throw new Error("RPC weg");
      },
    };
    const result = await tickOpenPositions(deps, config);
    expect(result.ticked).toBe(0);
    expect(result.closed).toBe(0);
    expect(result.notes.join(" ")).toContain("nicht abrufbar");
  });

  it("meldet Positionen, deren Preset aus der Konfiguration entfernt wurde", async () => {
    const store = new FakeStore();
    await openFromScan(buildDeps(store), config, [acceptedRow("degen")]);
    const withoutDegen = {
      ...config,
      presets: { konservativ: config.presets["konservativ"]! },
    };
    const result = await tickOpenPositions(buildDeps(store), withoutDegen, );
    expect(result.notes.join(" ")).toContain("existiert nicht mehr");
  });

  it("räumt bei killSwitch 'flatten' alles ab, auch gesunde Positionen", async () => {
    const store = new FakeStore();
    await openFromScan(buildDeps(store), config, [
      acceptedRow("degen"),
      acceptedRow("balanced"),
    ]);
    expect(store.positions).toHaveLength(2);

    const later = new Date(T0.getTime() + 3_600_000);
    // Unauffälliger Markt: Ohne den Kill-Switch bliebe hier alles offen.
    const calm = buildPool({ priceNative: 0.0000214 * 0.99 });
    const flatten = { ...config, global: { ...config.global, killSwitch: "flatten" as const } };
    const result = await tickOpenPositions(buildDeps(store, calm, later), flatten);

    expect(result.closed).toBe(2);
    expect(store.positions.every((p) => p.closed)).toBe(true);
    // Eigener Grund statt `manual`: Im Ausstiegsgrund-Histogramm ist eine
    // Notbremse etwas anderes als ein Eingriff von Hand.
    expect(store.positions.map((p) => p.reason)).toEqual(["kill_switch", "kill_switch"]);
  });

  it("lässt Positionen bei killSwitch 'pause' laufen — er stoppt nur Neueinstiege", async () => {
    const store = new FakeStore();
    await openFromScan(buildDeps(store), config, [acceptedRow("degen")]);

    const later = new Date(T0.getTime() + 3_600_000);
    const calm = buildPool({ priceNative: 0.0000214 * 0.99 });
    const paused = { ...config, global: { ...config.global, killSwitch: "pause" as const } };
    const result = await tickOpenPositions(buildDeps(store, calm, later), paused);

    expect(result.closed).toBe(0);
    expect(store.positions[0]!.closed).toBe(false);
  });
});

describe("formatComparison", () => {
  it("sortiert nach PnL und warnt bei zu kleiner Stichprobe", () => {
    const rows: PresetPerformance[] = [
      {
        preset: "degen",
        label: "Degen",
        openPositions: 1,
        closedPositions: 2,
        realizedPnlSol: -0.05,
        unrealizedPnlSol: 0,
        depositedSol: 3,
      totalPnlSol: -0.05,
        feesEarnedSol: 0.01,
        costsSol: 0.003,
        wins: 0,
        losses: 2,
        winRatePct: 0,
        avgTimeInRangePct: 40,
        vsHodlSol: -0.02,
      },
      {
        preset: "konservativ",
        label: "Konservativ",
        openPositions: 2,
        closedPositions: 3,
        realizedPnlSol: 0.12,
        unrealizedPnlSol: 0.01,
        depositedSol: 3,
      totalPnlSol: 0.13,
        feesEarnedSol: 0.15,
        costsSol: 0.004,
        wins: 2,
        losses: 1,
        winRatePct: 66.7,
        avgTimeInRangePct: 85,
        vsHodlSol: 0.03,
      },
    ];
    const table = formatComparison(rows);
    const konservativLine = table.indexOf("Konservativ");
    const degenLine = table.indexOf("Degen");
    expect(konservativLine).toBeLessThan(degenLine);
    expect(table).toContain("+0.1300");
    expect(table).toContain("zu wenig für belastbare Aussagen");
  });

  it("meldet leeren Stand statt einer leeren Tabelle", () => {
    expect(formatComparison([])).toContain("Noch keine Paper-Positionen");
  });
});

/** Der HODL-Vergleich ist die eigentliche Frage an das Paper-Trading. */
describe("HODL-Vergleich", () => {
  it("weist aus, ob LPing gegenüber reinem Halten gewonnen hat", () => {
    const state = openPaperPosition({
      preset: config.presets["degen"]!,
      global: config.global,
      binStep: 100,
      price: 1,
      depositSol: 1,
      feePct: 1,
      at: T0,
    });
    const valuation = valuePosition(state, 1);
    expect(valuation.hodlValueSol).toBeCloseTo(1);
    // Direkt nach dem Einstieg liegt die Position um die Kosten hinten.
    expect(valuation.vsHodlSol).toBeLessThan(0);
  });
});
