import type {
  PoolMetrics,
  SellabilityCheck,
  TokenOrganics,
  TokenRiskReport,
} from "../domain/types";
import type { MarketAggregates } from "../screening/types";

/**
 * Merkmalsvektor eines Kandidaten zum **Entscheidungszeitpunkt**
 * (KONZEPT-ML.md Abschnitt 3.2).
 *
 * Die wichtigste Regel dieses Moduls: Hier darf ausschließlich einfließen, was
 * zum Zeitpunkt der Entscheidung bekannt war. Jede spätere Information (etwa der
 * endgültige Holder-Stand oder der Preis in sechs Stunden) wäre Look-Ahead-Bias
 * und würde ein Modell erzeugen, das im Test glänzt und live wertlos ist.
 * Ergebnisse werden deshalb getrennt erfasst (siehe candidate_outcomes).
 *
 * Werte sind bewusst flach und primitiv gehalten, damit sie sich ohne
 * Umbau nach CSV/Parquet exportieren und von beliebigen Werkzeugen lesen lassen.
 * `null` heißt durchgängig "nicht verfügbar" — Modelle müssen das behandeln
 * können, statt dass wir hier Werte erfinden.
 */

export type FeatureValue = number | string | boolean | null;
export type FeatureVector = Record<string, FeatureValue>;

/**
 * Version des Merkmalsschemas. Bei jeder Änderung an Namen oder Bedeutung
 * erhöhen — Datensätze verschiedener Versionen dürfen nicht vermischt werden.
 */
export const FEATURE_VERSION = 1;

/** Alle Merkmalsnamen in stabiler Reihenfolge (Spaltenreihenfolge im Export). */
export const FEATURE_KEYS = [
  // --- Pool ---------------------------------------------------------------
  "bin_step",
  "base_fee_pct",
  "tvl_usd",
  "pool_volume_24h_usd",
  "pool_fees_24h_usd",
  "fee_tvl_24h_pct",
  "vol_tvl_ratio",
  "price_native",
  // --- Markt (DexScreener) ------------------------------------------------
  "token_age_hours",
  "market_liquidity_usd",
  "market_volume_24h_usd",
  "txns_24h",
  "buy_sell_ratio",
  "avg_trade_usd",
  "price_change_h6_pct",
  "price_change_h24_pct",
  "pair_count",
  "price_divergence_pct",
  // --- Risiko (RugCheck) --------------------------------------------------
  "risk_score",
  "mint_authority_revoked",
  "freeze_authority_revoked",
  "top10_holder_pct",
  "insider_pct",
  "holders",
  "danger_flag_count",
  // --- Ausführbarkeit (Jupiter Quote) -------------------------------------
  "roundtrip_loss_pct",
  "buy_impact_pct",
  "sell_impact_pct",
  "sellability",
  // --- Organik (Jupiter Token API v2) -------------------------------------
  "organic_score",
  "organic_score_label",
  "jup_holder_count",
  "jup_is_verified",
  "jup_top_holders_pct",
  "jup_fdv_usd",
  // --- Abgeleitet / Querschnitt -------------------------------------------
  "tvl_ratio_pool_to_market",
  "authority_agreement",
] as const;

export interface FeatureInput {
  pool: PoolMetrics;
  market: MarketAggregates | null;
  risk: TokenRiskReport | null;
  sellability: SellabilityCheck | null;
  organics: TokenOrganics | null;
  /** Preisabweichung Pool ↔ Markt, falls berechenbar. */
  priceDivergencePct: number | null;
}

export function buildFeatureVector(input: FeatureInput): FeatureVector {
  const { pool, market, risk, sellability, organics } = input;

  const volTvlRatio =
    pool.tvlUsd !== undefined && pool.tvlUsd > 0 && pool.volume24hUsd !== undefined
      ? pool.volume24hUsd / pool.tvlUsd
      : null;

  const txns = market?.txns24h ?? null;
  const txnCount = txns === null ? null : txns.buys + txns.sells;
  const buySellRatio = txns !== null && txns.sells > 0 ? txns.buys / txns.sells : null;
  const avgTradeUsd =
    txnCount !== null && txnCount > 0 && market?.volume24hUsd != null
      ? market.volume24hUsd / txnCount
      : null;

  const dangerFlags =
    risk === null
      ? null
      : risk.risks.filter((r) => (r.level ?? "").toLowerCase() === "danger").length;

  // Stimmen RugCheck und Jupiter bei den Autoritäten überein? Widerspruch ist
  // ein eigenständiges Warnsignal, das keine der Quellen allein liefert.
  const authorityAgreement = agreement(
    risk?.mintAuthorityRevoked ?? null,
    organics?.mintAuthorityDisabled ?? null,
    risk?.freezeAuthorityRevoked ?? null,
    organics?.freezeAuthorityDisabled ?? null,
  );

  const vector: FeatureVector = {
    bin_step: pool.binStep,
    base_fee_pct: pool.baseFeePct ?? null,
    tvl_usd: pool.tvlUsd ?? null,
    pool_volume_24h_usd: pool.volume24hUsd ?? null,
    pool_fees_24h_usd: pool.fees24hUsd ?? null,
    fee_tvl_24h_pct: pool.feeTvl24hPct ?? null,
    vol_tvl_ratio: volTvlRatio,
    price_native: pool.priceNative ?? null,

    token_age_hours: market?.tokenAgeHours ?? null,
    market_liquidity_usd: market?.totalLiquidityUsd ?? null,
    market_volume_24h_usd: market?.volume24hUsd ?? null,
    txns_24h: txnCount,
    buy_sell_ratio: buySellRatio,
    avg_trade_usd: avgTradeUsd,
    price_change_h6_pct: market?.priceChangeH6Pct ?? null,
    price_change_h24_pct: market?.priceChangeH24Pct ?? null,
    pair_count: market?.pairCount ?? null,
    price_divergence_pct: input.priceDivergencePct,

    risk_score: risk?.normalizedScore ?? null,
    mint_authority_revoked: risk?.mintAuthorityRevoked ?? null,
    freeze_authority_revoked: risk?.freezeAuthorityRevoked ?? null,
    top10_holder_pct: risk?.top10HolderPct ?? null,
    insider_pct: risk?.insiderPct ?? null,
    holders: risk?.totalHolders ?? null,
    danger_flag_count: dangerFlags,

    roundtrip_loss_pct: sellability?.roundTripLossPct ?? null,
    buy_impact_pct: sellability?.buyImpactPct ?? null,
    sell_impact_pct: sellability?.sellImpactPct ?? null,
    sellability: sellability?.verdict ?? null,

    organic_score: organics?.organicScore ?? null,
    organic_score_label: organics?.organicScoreLabel ?? null,
    jup_holder_count: organics?.holderCount ?? null,
    jup_is_verified: organics?.isVerified ?? null,
    jup_top_holders_pct: organics?.topHoldersPct ?? null,
    jup_fdv_usd: organics?.fdvUsd ?? null,

    // Anteil des Pools an der Gesamtliquidität des Tokens: zeigt, ob dieser
    // Pool der Hauptmarkt ist oder ein Nebenschauplatz.
    tvl_ratio_pool_to_market:
      pool.tvlUsd !== undefined && market?.totalLiquidityUsd != null && market.totalLiquidityUsd > 0
        ? pool.tvlUsd / market.totalLiquidityUsd
        : null,
    authority_agreement: authorityAgreement,
  };

  return vector;
}

/**
 * Vergleicht die Autoritäts-Angaben zweier Quellen.
 * `agree` = beide sagen dasselbe, `conflict` = Widerspruch, `partial` = nur
 * eine Quelle liefert Daten, `unknown` = keine.
 */
function agreement(
  mintA: boolean | null,
  mintB: boolean | null,
  freezeA: boolean | null,
  freezeB: boolean | null,
): string {
  const pairs: [boolean | null, boolean | null][] = [
    [mintA, mintB],
    [freezeA, freezeB],
  ];
  let known = 0;
  let conflicts = 0;
  let both = 0;
  for (const [a, b] of pairs) {
    if (a !== null || b !== null) known++;
    if (a !== null && b !== null) {
      both++;
      if (a !== b) conflicts++;
    }
  }
  if (known === 0) return "unknown";
  if (conflicts > 0) return "conflict";
  if (both === pairs.length) return "agree";
  return "partial";
}

/** CSV-Kopfzeile für den Datenexport. */
export function featureHeader(): string {
  return FEATURE_KEYS.join(",");
}

/** Eine Merkmalszeile als CSV, in der Reihenfolge von FEATURE_KEYS. */
export function featureRow(vector: FeatureVector): string {
  return FEATURE_KEYS.map((key) => {
    const value = vector[key];
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    if (typeof value === "boolean") return value ? "1" : "0";
    return String(value);
  }).join(",");
}
