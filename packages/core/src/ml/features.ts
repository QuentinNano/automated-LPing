import { WSOL_MINT } from "../domain/constants";
import {
  METRIC_WINDOWS,
  feeCurrencyOf,
  type MetricWindow,
  type PoolMetrics,
  type SellabilityCheck,
  type TokenOrganics,
  type TokenRiskReport,
  type WindowedMetric,
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
 *
 * v2: Zeitfenster-Kennzahlen und -Trends, Gebührenstruktur (dynamische Gebühr,
 * Protokollanteil, `collect_fee_mode`), Farm-Rewards und die Token-Angaben, die
 * die Pool-API ohnehin mitliefert. Alles davon war in v1 verfügbar und wurde
 * verworfen.
 */
export const FEATURE_VERSION = 2;

/** Alle Merkmalsnamen in stabiler Reihenfolge (Spaltenreihenfolge im Export). */
export const FEATURE_KEYS = [
  // --- Pool ---------------------------------------------------------------
  "bin_step",
  "base_fee_pct",
  // Gesamtgebühr inkl. Volatilitätsaufschlag — der Satz, mit dem Swaps
  // tatsächlich belastet werden. base_fee_pct ist nur die Untergrenze.
  "dynamic_fee_pct",
  "max_fee_pct",
  // Anteil der Gebühr, der ans Protokoll geht (Standard 10 %, Launch 20 %).
  "protocol_fee_pct",
  // Gebührenwährung des Pools: entscheidet über Token-Exposure der Fees.
  "collect_fee_mode",
  "fee_currency",
  "tvl_usd",
  "pool_age_hours",
  "pool_volume_24h_usd",
  "pool_fees_24h_usd",
  "fee_tvl_24h_pct",
  "vol_tvl_ratio",
  "price_native",
  // --- Pool: kurze Zeitfenster und Trends ---------------------------------
  "pool_volume_30m_usd",
  "pool_volume_1h_usd",
  "pool_volume_4h_usd",
  "fee_tvl_30m_pct",
  "fee_tvl_1h_pct",
  "fee_tvl_4h_pct",
  // Verhältnis der aktuellen Rate zur Tagesrate: > 1 = Ertragskraft steigt.
  "fee_tvl_trend_1h_vs_24h",
  "volume_burst_1h",
  // 1 = gleichmäßiger Handel, → 0 = wenige Bursts (Wash-Trading-Indiz).
  "volume_steadiness",
  // --- Pool: Rewards und Herkunft -----------------------------------------
  "has_farm",
  "farm_apr",
  "launchpad",
  "pool_tags",
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
  // --- Token-Angaben aus der Pool-API (ohne Extra-Abruf) -------------------
  "pool_token_holders",
  "pool_token_verified",
  "pool_freeze_authority_disabled",
  "pool_token_market_cap_usd",
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
  /** Bezugszeitpunkt für Altersangaben; Default: jetzt. */
  now?: Date;
}

/** Stundenlänge der Zeitfenster — Grundlage aller Raten-Vergleiche. */
const WINDOW_HOURS: Record<MetricWindow, number> = {
  m30: 0.5,
  h1: 1,
  h2: 2,
  h4: 4,
  h12: 12,
  h24: 24,
};

export function buildFeatureVector(input: FeatureInput): FeatureVector {
  const { pool, market, risk, sellability, organics } = input;
  const now = input.now ?? new Date();

  const volTvlRatio =
    pool.tvlUsd !== undefined && pool.tvlUsd > 0 && pool.volume24hUsd !== undefined
      ? pool.volume24hUsd / pool.tvlUsd
      : null;

  // Die Nicht-SOL-Seite trägt die Token-Information; bei SOL/X-Pools ist das X.
  const baseSide = pool.mintY === WSOL_MINT ? pool.tokenX : pool.tokenY;

  const poolAgeHours =
    pool.poolCreatedAt !== undefined
      ? (now.getTime() - pool.poolCreatedAt.getTime()) / 3_600_000
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
    dynamic_fee_pct: pool.dynamicFeePct ?? null,
    max_fee_pct: pool.maxFeePct ?? null,
    protocol_fee_pct: pool.protocolFeePct ?? null,
    collect_fee_mode: pool.collectFeeMode ?? null,
    fee_currency: feeCurrencyOf(pool, WSOL_MINT),
    tvl_usd: pool.tvlUsd ?? null,
    pool_age_hours: poolAgeHours,
    pool_volume_24h_usd: pool.volume24hUsd ?? null,
    pool_fees_24h_usd: pool.fees24hUsd ?? null,
    fee_tvl_24h_pct: pool.feeTvl24hPct ?? null,
    vol_tvl_ratio: volTvlRatio,
    price_native: pool.priceNative ?? null,

    pool_volume_30m_usd: pool.volumeUsd.m30 ?? null,
    pool_volume_1h_usd: pool.volumeUsd.h1 ?? null,
    pool_volume_4h_usd: pool.volumeUsd.h4 ?? null,
    fee_tvl_30m_pct: pool.feeTvlPct.m30 ?? null,
    fee_tvl_1h_pct: pool.feeTvlPct.h1 ?? null,
    fee_tvl_4h_pct: pool.feeTvlPct.h4 ?? null,
    fee_tvl_trend_1h_vs_24h: rateRatio(pool.feeTvlPct, "h1", "h24"),
    volume_burst_1h: rateRatio(pool.volumeUsd, "h1", "h24"),
    volume_steadiness: steadiness(pool.volumeUsd),

    has_farm: pool.hasFarm ?? null,
    farm_apr: pool.farmApr ?? null,
    launchpad: pool.launchpad ?? null,
    pool_tags: pool.tags.length > 0 ? pool.tags.join("|") : null,

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

    pool_token_holders: baseSide?.holders ?? null,
    pool_token_verified: baseSide?.isVerified ?? null,
    pool_freeze_authority_disabled: baseSide?.freezeAuthorityDisabled ?? null,
    pool_token_market_cap_usd: baseSide?.marketCapUsd ?? null,

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
 * Verhältnis zweier Fenster als **Rate pro Stunde**, nicht als Rohwert.
 *
 * `> 1` heißt: das kurze Fenster liegt über dem Durchschnitt des langen — die
 * Kennzahl zieht gerade an. Genau dieser Trend ist laut KONZEPT-ML.md 4.2
 * aussagekräftiger als das 24-Stunden-Niveau, das ein abklingendes Strohfeuer
 * nicht von einem anlaufenden Pool unterscheiden kann.
 */
function rateRatio(
  metric: WindowedMetric,
  shortWindow: MetricWindow,
  longWindow: MetricWindow,
): number | null {
  const short = metric[shortWindow];
  const long = metric[longWindow];
  if (short === undefined || long === undefined || long <= 0) return null;
  const shortRate = short / WINDOW_HOURS[shortWindow];
  const longRate = long / WINDOW_HOURS[longWindow];
  if (longRate <= 0) return null;
  return shortRate / longRate;
}

/**
 * Gleichmäßigkeit des Handels über die verfügbaren Fenster: kleinste durch
 * größte Stundenrate. `1` = völlig gleichmäßig, Werte nahe `0` = das Volumen
 * steckt in wenigen Bursts.
 *
 * Das ist die billige Variante der Wash-Trading-Heuristik aus KONZEPT.md 5.3:
 * echte Nachfrage verteilt sich, gefälschtes Volumen kommt schubweise.
 * Aussagekräftig erst ab drei Fenstern — darunter `null` statt einer Zahl, die
 * Genauigkeit vortäuscht.
 */
function steadiness(metric: WindowedMetric): number | null {
  const rates: number[] = [];
  for (const window of METRIC_WINDOWS) {
    const value = metric[window];
    if (value === undefined || !Number.isFinite(value) || value < 0) continue;
    rates.push(value / WINDOW_HOURS[window]);
  }
  if (rates.length < 3) return null;
  const max = Math.max(...rates);
  if (max <= 0) return null;
  return Math.min(...rates) / max;
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
