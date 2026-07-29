import { describe, expect, it } from "vitest";
import { USDC_MINT, WSOL_MINT, type MarketPairSnapshot, type PoolMetrics } from "@lping/core";
import { discoverPools, formatScanTable, runScan, type ScanDeps } from "../src/scan";
import {
  TOKEN_MINT,
  buildPool,
  buildRisk,
  buildSellability,
  loadDefaultConfig,
} from "../../../packages/core/test/builders";

const config = loadDefaultConfig();
const NOW = Date.now();

function dexPair(): MarketPairSnapshot {
  return {
    pairAddress: "PairAddr",
    baseToken: { mint: TOKEN_MINT, symbol: "WIF" },
    quoteToken: { mint: WSOL_MINT, symbol: "SOL" },
    priceNative: 0.0000214,
    priceUsd: 0.00389,
    liquidityUsd: 250_000,
    volume: { h24: 1_250_000 },
    txns: { h24: { buys: 3200, sells: 3100 } },
    priceChange: { h6: 20, h24: 12 },
    pairCreatedAt: new Date(NOW - 24 * 3_600_000),
    fetchedAt: new Date(NOW),
    source: "dexscreener",
  };
}

function buildDeps(records: unknown[]): ScanDeps {
  return {
    meteora: {
      async getPairsPage() {
        return {
          pairs: [
            buildPool(),
            buildPool({ poolAddress: "UsdcPool111111111111111111111111111111111", mintY: USDC_MINT }),
            buildPool({ poolAddress: "DeadPool1111111111111111111111111111111111", tvlUsd: 5_000 }),
          ],
          skipped: 0,
        };
      },
    },
    dexscreener: {
      async getPairsForToken() {
        return { pairs: [dexPair()], skipped: 0 };
      },
    },
    rugcheck: {
      async getReport() {
        return buildRisk();
      },
    },
    jupiter: {
      async checkSellability() {
        return buildSellability();
      },
    },
    persist: {
      async recordScreened(input) {
        records.push(input);
      },
    },
  };
}

describe("runScan", () => {
  it("screent denselben Pool gegen alle aktiven Presets", async () => {
    const records: unknown[] = [];
    const summary = await runScan(buildDeps(records), config, { pages: 3 });

    // Nur 1 Seite geliefert (< limit) → keine weiteren Seiten angefragt.
    expect(summary.poolsScanned).toBe(3);
    // USDC- und Mini-TVL-Pool fliegen im Vor-Filter raus; der gesunde Pool
    // landet in der Shortlist jedes Presets.
    expect(summary.shortlisted).toEqual({ konservativ: 1, balanced: 1, degen: 1 });
    expect(summary.rows).toHaveLength(3);

    // Degen akzeptiert den 24h alten Token …
    const degenRow = summary.rows.find((r) => r.preset === "degen");
    expect(degenRow?.screening.verdict).toBe("accepted");
    expect(degenRow?.screening.score.total).toBeGreaterThan(70);

    // … die vorsichtigeren Presets lehnen ihn wegen des Alters ab.
    for (const preset of ["balanced", "konservativ"]) {
      const row = summary.rows.find((r) => r.preset === preset);
      expect(row?.screening.verdict, preset).toBe("rejected");
      expect(row?.screening.rejectedBy, preset).toContain("token_age");
    }

    expect(summary.accepted).toBe(1);
    expect(summary.rejected).toBe(2);
  });

  it("persistiert jede gescreente Zeile mit Quelle und Preset", async () => {
    const records: { preset?: string; source?: string }[] = [];
    const summary = await runScan(buildDeps(records), config, { pages: 1 });
    expect(summary.persisted).toBe(3);
    expect(records.map((r) => r.preset).sort()).toEqual(["balanced", "degen", "konservativ"]);
    expect(new Set(records.map((r) => r.source))).toEqual(new Set(["replicated"]));
  });

  it("Persistenz-Fehler stoppen den Scan nicht", async () => {
    const deps = buildDeps([]);
    deps.persist = {
      async recordScreened() {
        throw new Error("DB weg");
      },
    };
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);
    const summary = await runScan(deps, config, { pages: 1 });
    expect(summary.persisted).toBe(0);
    expect(summary.rows.length).toBe(3);
    expect(logs.join("\n")).toContain("Persistenz fehlgeschlagen");
  });

  it("Enrichment-Fehler führen zu fail-closed-Ablehnung statt Absturz", async () => {
    const deps = buildDeps([]);
    deps.rugcheck = {
      async getReport() {
        throw new Error("rugcheck down");
      },
    };
    const summary = await runScan(deps, config, { pages: 1 });
    const degenRow = summary.rows.find((r) => r.preset === "degen");
    expect(degenRow?.screening.verdict).toBe("rejected");
    expect(degenRow?.screening.rejectedBy).toContain("risk_score");
  });

  it("formatScanTable rendert Verdicts und Summary", async () => {
    const summary = await runScan(buildDeps([]), config, { pages: 1 });
    const table = formatScanTable(summary);
    expect(table).toContain("✓ OK");
    expect(table).toContain("✗ raus");
    expect(table).toContain("akzeptiert 1");
  });

  it("zählt die Ausschlussgründe des Vor-Filters", async () => {
    const summary = await runScan(buildDeps([]), config, { pages: 1 });
    // USDC-Pool (nicht SOL-quotiert) und Mini-TVL-Pool fallen bei jedem Preset raus.
    for (const preset of ["degen", "balanced", "konservativ"]) {
      const reasons = summary.prefilterReasons[preset]?.map(([kind]) => kind) ?? [];
      expect(reasons, preset).toContain("nicht");
    }
  });

  it("erklärt eine leere Trefferliste, statt nur eine leere Tabelle zu zeigen", async () => {
    const deps = buildDeps([]);
    // Nur Pools, die an der TVL-Schwelle scheitern.
    deps.meteora = {
      async getPairsPage() {
        return { pairs: [buildPool({ tvlUsd: 100 })], skipped: 0 };
      },
    };
    const summary = await runScan(deps, config, { pages: 1 });

    expect(summary.rows).toHaveLength(0);
    const output = formatScanTable(summary);
    expect(output).toContain("Kein Pool hat den Vor-Filter passiert");
    expect(output).toContain("TVL");
    expect(output).toContain("api:check");
  });

  it("weist darauf hin, wenn gar keine Pools geladen wurden", async () => {
    const deps = buildDeps([]);
    deps.meteora = {
      async getPairsPage() {
        return { pairs: [], skipped: 0 };
      },
    };
    const output = formatScanTable(await runScan(deps, config, { pages: 1 }));
    expect(output).toContain("gar keine Pools");
    expect(output).toContain("api:check");
  });
});

describe("discoverPools", () => {
  /** Zeichnet die gestellten Abfragen auf und liefert je Sortierung eigene Pools. */
  function recordingDeps(
    perSort: Record<string, PoolMetrics[][]>,
  ): { deps: ScanDeps; queries: { sortBy?: string; filterBy?: string; page?: number }[] } {
    const queries: { sortBy?: string; filterBy?: string; page?: number }[] = [];
    const deps = buildDeps([]);
    deps.meteora = {
      async getPairsPage(params) {
        queries.push({ sortBy: params.sortBy, filterBy: params.filterBy, page: params.page });
        const pages = perSort[params.sortBy ?? ""] ?? [];
        const pairs = pages[params.page ?? 0] ?? [];
        return { pairs, skipped: 0, rawCount: pairs.length, serverFiltered: true };
      },
    };
    return { deps, queries };
  }

  it("führt alle Sortierungen zusammen und dedupliziert nach Pool-Adresse", async () => {
    const shared = buildPool({ poolAddress: "Shared11111111111111111111111111111111111" });
    const { deps, queries } = recordingDeps({
      "volume_24h:desc": [[shared, buildPool({ poolAddress: "OnlyVolume11111111111111111111111111111" })]],
      "fee_tvl_ratio_1h:desc": [[shared, buildPool({ poolAddress: "OnlyFeeRate1111111111111111111111111111" })]],
      "pool_created_at:desc": [[shared, buildPool({ poolAddress: "OnlyFresh111111111111111111111111111111" })]],
    });

    const result = await discoverPools(deps, config, { pages: 1 });

    // 1 gemeinsamer + 3 exklusive Pools, nicht 6.
    expect(result.pools).toHaveLength(4);
    expect(queries.map((q) => q.sortBy)).toEqual([
      "volume_24h:desc",
      "fee_tvl_ratio_1h:desc",
      "pool_created_at:desc",
    ]);
    // Die frische Sortierung trägt genau einen Pool bei, den sonst niemand liefert.
    expect(result.perStrategy).toEqual([
      { id: "volume", found: 2, added: 2 },
      { id: "fee_rate", found: 2, added: 1 },
      { id: "fresh", found: 2, added: 1 },
    ]);
  });

  it("filtert serverseitig mit der niedrigsten TVL-Schwelle aller Presets", async () => {
    const { deps, queries } = recordingDeps({ "volume_24h:desc": [[buildPool()]] });

    const result = await discoverPools(deps, config, { pages: 1 });

    // degen hat die niedrigste Schwelle (50k), Vor-Filter-Nachlass 0,5 → 25k.
    expect(result.filter).toBe("is_blacklisted=false && tvl>=25000");
    for (const query of queries) expect(query.filterBy).toBe(result.filter);
  });

  it("paginiert anhand der Rohanzahl, nicht der verwertbaren Einträge", async () => {
    // Seite 0 liefert 2 verwertbare von 3 Rohdatensätzen — bei pageLimit 3 ist
    // die Seite voll, es muss also eine zweite Seite angefragt werden.
    const queries: (number | undefined)[] = [];
    const deps = buildDeps([]);
    deps.meteora = {
      async getPairsPage(params) {
        queries.push(params.page);
        if (params.sortBy !== "volume_24h:desc") return { pairs: [], skipped: 0, rawCount: 0, serverFiltered: true };
        if (params.page === 0) {
          return {
            pairs: [buildPool(), buildPool({ poolAddress: "Second11111111111111111111111111111111111" })],
            skipped: 1,
            rawCount: 3,
            serverFiltered: true,
          };
        }
        return {
          pairs: [buildPool({ poolAddress: "Third111111111111111111111111111111111111" })],
          skipped: 0,
          rawCount: 1,
          serverFiltered: true,
        };
      },
    };

    const result = await discoverPools(deps, config, { pages: 4, pageLimit: 3 });

    expect(queries.slice(0, 2)).toEqual([0, 1]);
    expect(result.pools.map((p) => p.poolAddress)).toContain(
      "Third111111111111111111111111111111111111",
    );
  });

  it("bricht nach einer Runde ab, wenn die Quelle nicht serverseitig sortiert", async () => {
    // Die ältere Schnittstelle ignoriert sort_by — weitere Sortierungen würden
    // dieselbe Liste erneut abrufen.
    const queries: (string | undefined)[] = [];
    const deps = buildDeps([]);
    deps.meteora = {
      async getPairsPage(params) {
        queries.push(params.sortBy);
        return { pairs: [buildPool()], skipped: 0, rawCount: 1, serverFiltered: false };
      },
    };
    const logs: string[] = [];
    deps.log = (line) => logs.push(line);

    const result = await discoverPools(deps, config, { pages: 3 });

    expect(queries).toEqual(["volume_24h:desc"]);
    expect(result.serverFiltered).toBe(false);
    expect(logs.join("\n")).toContain("ohne serverseitige Sortierung");
  });
});
