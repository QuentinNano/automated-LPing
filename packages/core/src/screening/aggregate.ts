import { WSOL_MINT } from "../domain/constants";
import type { MarketPairSnapshot, PoolMetrics } from "../domain/types";
import type { MarketAggregates } from "./types";

/**
 * Liefert die Nicht-SOL-Seite eines Pools oder null, wenn der Pool nicht
 * SOL-quotiert ist (v1-Regel: nur X/SOL-Pools, KONZEPT.md Abschnitt 5.3).
 */
export function tokenSideOf(pool: Pick<PoolMetrics, "mintX" | "mintY">): string | null {
  if (pool.mintY === WSOL_MINT) return pool.mintX;
  if (pool.mintX === WSOL_MINT) return pool.mintY;
  return null;
}

/**
 * Token-Preis des Pools in SOL, orientierungsbereinigt: Meteora liefert den
 * Preis von mintX in mintY — bei SOL/TOKEN-Pools muss invertiert werden.
 */
export function poolPriceInSol(
  pool: Pick<PoolMetrics, "mintX" | "mintY" | "priceNative">,
): number | null {
  if (pool.priceNative === undefined || pool.priceNative <= 0) return null;
  if (pool.mintY === WSOL_MINT) return pool.priceNative;
  if (pool.mintX === WSOL_MINT) return 1 / pool.priceNative;
  return null;
}

/**
 * Aggregiert DexScreener-Paare eines Tokens zu einem Markt-Querschnitt.
 * Preis-Statistiken nutzen nur SOL-quotierte Paare mit dem Token als Base;
 * Liquidität/Volumen/Trades summieren über alle Paare.
 */
export function aggregateMarket(
  tokenMint: string,
  pairs: MarketPairSnapshot[],
  now: Date = new Date(),
): MarketAggregates {
  const relevant = pairs.filter(
    (p) => p.baseToken.mint === tokenMint || p.quoteToken.mint === tokenMint,
  );

  const solQuoted = relevant.filter(
    (p) => p.baseToken.mint === tokenMint && p.quoteToken.mint === WSOL_MINT,
  );

  const liquidity = sumDefined(relevant.map((p) => p.liquidityUsd));
  const volume = sumDefined(relevant.map((p) => p.volume.h24));

  let buys = 0;
  let sells = 0;
  let hasTxns = false;
  for (const pair of relevant) {
    if (pair.txns.h24 !== undefined) {
      hasTxns = true;
      buys += pair.txns.h24.buys;
      sells += pair.txns.h24.sells;
    }
  }

  const createdTimes = relevant
    .map((p) => p.pairCreatedAt?.getTime())
    .filter((t): t is number => t !== undefined && Number.isFinite(t));
  const tokenAgeHours =
    createdTimes.length > 0 ? (now.getTime() - Math.min(...createdTimes)) / 3_600_000 : null;

  let solPriceUsd: number | null = null;
  for (const pair of solQuoted) {
    if (
      pair.priceUsd !== undefined &&
      pair.priceNative !== undefined &&
      pair.priceNative > 0 &&
      pair.priceUsd > 0
    ) {
      solPriceUsd = pair.priceUsd / pair.priceNative;
      break;
    }
  }

  const nativePrices = solQuoted
    .map((p) => p.priceNative)
    .filter((v): v is number => v !== undefined && v > 0);

  // Momentum aus dem liquidesten SOL-quotierten Paar (repräsentativster Markt).
  const primary = solQuoted
    .slice()
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0))
    .at(0);

  return {
    tokenAgeHours,
    totalLiquidityUsd: liquidity,
    volume24hUsd: volume,
    txns24h: hasTxns ? { buys, sells } : null,
    solPriceUsd,
    medianPriceNative: median(nativePrices),
    priceChangeH6Pct: primary?.priceChange?.h6 ?? null,
    priceChangeH24Pct: primary?.priceChange?.h24 ?? null,
    pairCount: relevant.length,
  };
}

/**
 * USD-Preis der SOL-Seite eines Pools, aus den Token-Angaben der Pool-API.
 *
 * Wird je Messpunkt gebraucht: Das Gebührenmodell rechnet den Pool-TVL in SOL
 * um, und anders als beim reinen TVL-Anteil kürzt sich der Umrechnungskurs im
 * Bin-Modell nicht heraus. Ohne ihn kann der Replay den Gebührenanteil nicht
 * rekonstruieren.
 */
export function solPriceUsdOf(
  pool: Pick<PoolMetrics, "mintX" | "mintY" | "tokenX" | "tokenY">,
): number | null {
  const side = pool.mintY === WSOL_MINT ? pool.tokenY : pool.mintX === WSOL_MINT ? pool.tokenX : null;
  const price = side?.priceUsd;
  return price !== undefined && Number.isFinite(price) && price > 0 ? price : null;
}

/** Absolute Abweichung des Pool-Preises vom Markt-Median in %. */
export function priceDivergencePct(
  pool: Pick<PoolMetrics, "mintX" | "mintY" | "priceNative">,
  market: Pick<MarketAggregates, "medianPriceNative">,
): number | null {
  const poolPrice = poolPriceInSol(pool);
  const marketPrice = market.medianPriceNative;
  if (poolPrice === null || marketPrice === null || marketPrice <= 0) return null;
  return (Math.abs(poolPrice - marketPrice) / marketPrice) * 100;
}

function sumDefined(values: (number | undefined)[]): number | null {
  const defined = values.filter((v): v is number => v !== undefined);
  if (defined.length === 0) return null;
  return defined.reduce((sum, v) => sum + v, 0);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (sorted.length % 2 === 0 && lower !== undefined && upper !== undefined) {
    return (lower + upper) / 2;
  }
  return upper ?? null;
}
