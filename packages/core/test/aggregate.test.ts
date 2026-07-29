import { describe, expect, it } from "vitest";
import {
  aggregateMarket,
  poolPriceInSol,
  priceDivergencePct,
  tokenSideOf,
  WSOL_MINT,
  USDC_MINT,
  type MarketPairSnapshot,
} from "@lping/core";
import { TOKEN_MINT, buildPool } from "./builders";

const NOW = new Date("2026-07-29T12:00:00Z");

function pair(overrides: Partial<MarketPairSnapshot>): MarketPairSnapshot {
  return {
    pairAddress: "PairAddr",
    baseToken: { mint: TOKEN_MINT, symbol: "WIF" },
    quoteToken: { mint: WSOL_MINT, symbol: "SOL" },
    volume: {},
    txns: {},
    fetchedAt: NOW,
    source: "dexscreener",
    ...overrides,
  };
}

describe("tokenSideOf / poolPriceInSol", () => {
  it("liefert die Nicht-SOL-Seite in beiden Orientierungen", () => {
    expect(tokenSideOf(buildPool())).toBe(TOKEN_MINT);
    expect(tokenSideOf(buildPool({ mintX: WSOL_MINT, mintY: TOKEN_MINT }))).toBe(TOKEN_MINT);
    expect(tokenSideOf(buildPool({ mintY: USDC_MINT }))).toBeNull();
  });

  it("invertiert den Preis bei SOL/TOKEN-Orientierung", () => {
    expect(poolPriceInSol(buildPool())).toBeCloseTo(0.0000214);
    const inverted = buildPool({ mintX: WSOL_MINT, mintY: TOKEN_MINT, priceNative: 46_729 });
    expect(poolPriceInSol(inverted)).toBeCloseTo(1 / 46_729);
  });
});

describe("aggregateMarket", () => {
  const solPair = pair({
    priceNative: 0.0000214,
    priceUsd: 0.00389,
    liquidityUsd: 250_000,
    volume: { h24: 1_250_000 },
    txns: { h24: { buys: 3200, sells: 3100 } },
    priceChange: { h6: 20, h24: 12 },
    pairCreatedAt: new Date(NOW.getTime() - 24 * 3_600_000),
  });
  const usdcPair = pair({
    pairAddress: "UsdcPair",
    quoteToken: { mint: USDC_MINT, symbol: "USDC" },
    liquidityUsd: 100_000,
    volume: { h24: 500_000 },
    txns: { h24: { buys: 900, sells: 800 } },
    pairCreatedAt: new Date(NOW.getTime() - 48 * 3_600_000),
  });

  it("summiert über alle Paare, Preis-Statistik nur aus SOL-quotierten", () => {
    const agg = aggregateMarket(TOKEN_MINT, [solPair, usdcPair], NOW);
    expect(agg.totalLiquidityUsd).toBeCloseTo(350_000);
    expect(agg.volume24hUsd).toBeCloseTo(1_750_000);
    expect(agg.txns24h).toEqual({ buys: 4100, sells: 3900 });
    // Alter aus dem ältesten Paar (48h)
    expect(agg.tokenAgeHours).toBeCloseTo(48);
    // solPrice = priceUsd / priceNative
    expect(agg.solPriceUsd).toBeCloseTo(0.00389 / 0.0000214, 2);
    expect(agg.medianPriceNative).toBeCloseTo(0.0000214);
    expect(agg.priceChangeH6Pct).toBe(20);
    expect(agg.pairCount).toBe(2);
  });

  it("liefert null-Felder bei leerer Paarliste", () => {
    const agg = aggregateMarket(TOKEN_MINT, [], NOW);
    expect(agg.tokenAgeHours).toBeNull();
    expect(agg.totalLiquidityUsd).toBeNull();
    expect(agg.txns24h).toBeNull();
    expect(agg.solPriceUsd).toBeNull();
    expect(agg.pairCount).toBe(0);
  });
});

describe("priceDivergencePct", () => {
  it("misst die Abweichung des Pool-Preises vom Markt-Median", () => {
    const divergence = priceDivergencePct(buildPool(), {
      medianPriceNative: 0.0000214 * 1.1,
    });
    expect(divergence).toBeCloseTo(9.09, 1);
  });

  it("liefert null ohne verwertbare Preise", () => {
    expect(priceDivergencePct(buildPool({ priceNative: undefined }), { medianPriceNative: 1 })).toBeNull();
    expect(priceDivergencePct(buildPool(), { medianPriceNative: null })).toBeNull();
  });
});
