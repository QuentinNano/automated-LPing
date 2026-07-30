import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  parseBotConfig,
  WSOL_MINT,
  type BotConfig,
  type MarketAggregates,
  type PoolMetrics,
  type PresetKind,
  type ScreeningInput,
  type SellabilityCheck,
  type TokenRiskReport,
} from "@lping/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const TOKEN_MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
export const POOL_ADDRESS = "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y";

export function loadDefaultConfig(): BotConfig {
  const read = (name: string) =>
    JSON.parse(readFileSync(path.join(repoRoot, "config", name), "utf8")) as unknown;
  return parseBotConfig({
    global: read("global.json"),
    presets: {
      konservativ: read("konservativ.json"),
      balanced: read("balanced.json"),
      degen: read("degen.json"),
    },
  });
}

/**
 * Gesunder Degen-Pool: TVL 250k, Vol/TVL 5, Fee/TVL 5 %/24h.
 *
 * Die Fenster-Kennzahlen werden aus den 24-Stunden-Werten abgeleitet, damit ein
 * Test nur das setzen muss, was er prüft. Wer ein bestimmtes Fenster braucht,
 * überschreibt `volumeUsd`/`feesUsd`/`feeTvlPct` direkt.
 */
export function buildPool(overrides: Partial<PoolMetrics> = {}): PoolMetrics {
  const base = {
    poolAddress: POOL_ADDRESS,
    name: "WIF-SOL",
    mintX: TOKEN_MINT,
    mintY: WSOL_MINT,
    binStep: 100,
    baseFeePct: 1,
    dynamicFeePct: 1.4,
    protocolFeePct: 10,
    collectFeeMode: "input_only" as const,
    tvlUsd: 250_000,
    volume24hUsd: 1_250_000,
    fees24hUsd: 12_500,
    feeTvl24hPct: 5,
    priceNative: 0.0000214,
    rewardMints: [],
    tags: [],
    fetchedAt: new Date("2026-07-29T12:00:00Z"),
    source: "meteora" as const,
    ...overrides,
  };

  return {
    ...base,
    volumeUsd: overrides.volumeUsd ?? spread24h(base.volume24hUsd),
    feesUsd: overrides.feesUsd ?? spread24h(base.fees24hUsd),
    feeTvlPct: overrides.feeTvlPct ?? spread24h(base.feeTvl24hPct),
    protocolFeesUsd: overrides.protocolFeesUsd ?? {},
  };
}

/** Verteilt einen 24-Stunden-Wert gleichmäßig auf die kürzeren Fenster. */
function spread24h(value: number | undefined): NonNullable<PoolMetrics["volumeUsd"]> {
  if (value === undefined) return {};
  return {
    m30: value / 48,
    h1: value / 24,
    h2: value / 12,
    h4: value / 6,
    h12: value / 2,
    h24: value,
  };
}

export function buildMarket(overrides: Partial<MarketAggregates> = {}): MarketAggregates {
  return {
    tokenAgeHours: 24,
    totalLiquidityUsd: 400_000,
    volume24hUsd: 1_500_000,
    txns24h: { buys: 3200, sells: 3100 },
    solPriceUsd: 180,
    medianPriceNative: 0.0000214,
    priceChangeH1Pct: 4,
    priceChangeH6Pct: 20,
    priceChangeH24Pct: 15,
    // Rund 30 %/Tag — innerhalb der Bänder aller Presets, damit der
    // Volatilitätsfilter in Bestandstests nicht als stiller Ablehner wirkt.
    volatilityPctDaily: 30,
    pairCount: 2,
    ...overrides,
  };
}

export function buildRisk(overrides: Partial<TokenRiskReport> = {}): TokenRiskReport {
  return {
    mint: TOKEN_MINT,
    rawScore: 501,
    normalizedScore: 6,
    risks: [{ name: "Top 10 holders high ownership", level: "warn" }],
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    topHolders: [
      { address: "A", pct: 5.2, insider: false },
      { address: "B", pct: 3.1, insider: true },
      { address: "C", pct: 2.1, insider: false },
    ],
    top10HolderPct: 10.4,
    insiderPct: 3.1,
    totalHolders: 51_234,
    totalMarketLiquidityUsd: 1_834_567,
    fetchedAt: new Date("2026-07-29T12:00:00Z"),
    source: "rugcheck",
    ...overrides,
  };
}

export function buildSellability(overrides: Partial<SellabilityCheck> = {}): SellabilityCheck {
  return {
    mint: TOKEN_MINT,
    buyOk: true,
    sellOk: true,
    buyImpactPct: 0.42,
    sellImpactPct: 0.55,
    roundTripLossPct: 3,
    verdict: "sellable",
    checkedAt: new Date("2026-07-29T12:00:00Z"),
    ...overrides,
  };
}

/** Vollständig gesunder Screening-Input für das gegebene Preset. */
export function buildInput(
  presetKind: PresetKind,
  config: BotConfig,
  overrides: Partial<ScreeningInput> = {},
): ScreeningInput {
  const preset = config.presets[presetKind];
  if (preset === undefined) throw new Error(`Unbekanntes Preset: ${presetKind}`);
  // Token-Alter passend zum Mindestalter des Presets, damit der Basis-Input
  // für jedes Profil ein gültiger Kandidat ist.
  const ageHours = Math.max(preset.tokenAgeHours.min * 1.5, 24);
  return {
    presetKind,
    preset,
    global: config.global,
    source: "replicated",
    pool: buildPool(),
    tokenMint: TOKEN_MINT,
    market: buildMarket({ tokenAgeHours: ageHours }),
    risk: buildRisk(),
    sellability: buildSellability(),
    ...overrides,
  };
}
