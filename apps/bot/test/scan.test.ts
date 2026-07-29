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
  it("Discovery → Enrichment → Screening: gesunder Degen-Pool wird akzeptiert", async () => {
    const records: unknown[] = [];
    const summary = await runScan(buildDeps(records), config, { pages: 3 });

    // Nur 1 Seite geliefert (< limit) → keine weiteren Seiten angefragt.
    expect(summary.poolsScanned).toBe(3);
    // USDC- und Mini-TVL-Pool fliegen im Vor-Filter raus.
    expect(summary.shortlisted.degen).toBe(1);
    expect(summary.shortlisted.multiday).toBe(1);

    const degenRow = summary.rows.find((r) => r.preset === "degen");
    expect(degenRow?.screening.verdict).toBe("accepted");
    expect(degenRow?.screening.score.total).toBeGreaterThan(70);

    // Multiday lehnt denselben Pool ab: Token ist erst 24h alt (>= 72h nötig).
    const multidayRow = summary.rows.find((r) => r.preset === "multiday");
    expect(multidayRow?.screening.verdict).toBe("rejected");
    expect(multidayRow?.screening.rejectedBy).toContain("token_age");

    expect(summary.accepted).toBe(1);
    expect(summary.rejected).toBe(1);
  });

  it("persistiert jede gescreente Zeile mit Quelle replicated_*", async () => {
    const records: { preset?: string; source?: string }[] = [];
    const summary = await runScan(buildDeps(records), config, { pages: 1 });
    expect(summary.persisted).toBe(2);
    expect(records.map((r) => r.source).sort()).toEqual([
      "replicated_degen",
      "replicated_multiday",
    ]);
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
    expect(summary.rows.length).toBe(2);
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
