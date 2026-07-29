import { describe, expect, it } from "vitest";
import { USDC_MINT, WSOL_MINT, type MarketPairSnapshot } from "@lping/core";
import { formatScanTable, runScan, type ScanDeps } from "../src/scan";
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
});
