import { poolPriceInSol } from "../screening/aggregate";
import { effectiveFeePct, type TrackPoint } from "../ml/outcomes";
import type { PoolMetrics } from "../domain/types";
import type { MarketTick } from "./types";

/**
 * Erzeugung der `MarketTick`s, mit denen die Simulation rechnet.
 *
 * Es gibt zwei Wege hierher — den Live-Betrieb aus frischen Pool-Metriken und
 * den Replay aus aufgezeichneten Beobachtungen — und **genau deshalb** liegen
 * beide in dieser Datei. KONZEPT-ML.md 5 nennt es nicht verhandelbar: Sobald
 * Replay und Live-Betrieb ihre Ticks unterschiedlich bauen, optimiert man gegen
 * die eine Welt und handelt in der anderen. Ein Test hält beide Wege aneinander.
 */

/**
 * Effektive Swap-Gebühr eines Pools in Prozent.
 *
 * Reihenfolge nach Genauigkeit: gemeldete Gesamtgebühr (Basis +
 * Volatilitätsaufschlag), sonst die realisierte Rate aus dem kürzesten belegten
 * Fenster, sonst über 24 h, zuletzt die Basisgebühr. Die Basisgebühr allein
 * unterschätzt volatile Pools deutlich — und genau in deren volatilen Phasen
 * verdient eine DLMM-Position.
 */
export function poolFeePct(pool: PoolMetrics): number {
  return effectiveFeePct(trackPointFromPool(pool)) ?? 0;
}

/**
 * Handelsvolumen als 24-Stunden-Rate, aus dem kürzesten belegten Fenster
 * hochgerechnet.
 *
 * Der rohe 24-Stunden-Wert glättet genau die Volatilitätsspitzen weg, in denen
 * Gebühren anfallen. `volume.h1 × 24` beschreibt den aktuellen Durchsatz
 * erheblich besser und kostet nichts — die Zahl steht im selben Response.
 */
export function volumeRate24hUsd(pool: PoolMetrics): number {
  const windows: [keyof PoolMetrics["volumeUsd"], number][] = [
    ["m30", 48],
    ["h1", 24],
    ["h2", 12],
    ["h4", 6],
    ["h12", 2],
    ["h24", 1],
  ];
  for (const [window, factor] of windows) {
    const value = pool.volumeUsd[window];
    if (value !== undefined && Number.isFinite(value)) return value * factor;
  }
  return pool.volume24hUsd ?? 0;
}

/** Pool-Metriken in die Beobachtungsform, die auch die Aufzeichnung schreibt. */
export function trackPointFromPool(pool: PoolMetrics): TrackPoint {
  return {
    ts: pool.fetchedAt,
    priceNative: pool.priceNative ?? null,
    tvlUsd: pool.tvlUsd ?? null,
    fees24hUsd: pool.fees24hUsd ?? null,
    volume24hUsd: pool.volume24hUsd ?? null,
    dynamicFeePct: pool.dynamicFeePct ?? null,
    baseFeePct: pool.baseFeePct ?? null,
    protocolFeePct: pool.protocolFeePct ?? null,
    windows: { volume: pool.volumeUsd, fees: pool.feesUsd },
  };
}

/** Was der Replay über den Pool wissen muss — die Zeitreihe sagt es nicht. */
export interface TickPool {
  mintX: string;
  mintY: string;
}

/**
 * Tick aus frischen Pool-Metriken (Live-Betrieb).
 *
 * `null`, wenn kein verwertbarer Preis vorliegt: Ohne ihn lässt sich die
 * Position nicht bewerten, und eine Null einzusetzen wäre schlimmer als den
 * Durchgang zu überspringen.
 */
export function marketTickFromPool(
  pool: PoolMetrics,
  context: { solPriceUsd: number; at: Date },
): MarketTick | null {
  const price = poolPriceInSol(pool);
  if (price === null || price <= 0) return null;

  return {
    priceInSol: price,
    poolTvlUsd: pool.tvlUsd ?? 0,
    poolVolume24hUsd: volumeRate24hUsd(pool),
    poolFeePct: poolFeePct(pool),
    solPriceUsd: context.solPriceUsd,
    ...(pool.protocolFeePct !== undefined ? { protocolFeePct: pool.protocolFeePct } : {}),
    at: context.at,
  };
}

/**
 * Tick aus einer aufgezeichneten Beobachtung (Replay).
 *
 * Zwei Dinge, die die Zeitreihe allein nicht hergibt:
 *
 * 1. **Die Preisrichtung.** Gespeichert ist `price_native` genau so, wie die API
 *    sie liefert — der Preis von Token X in Token Y. Bei einem SOL/X-Pool steht
 *    SOL auf der X-Seite, und der Wert muss invertiert werden. Deshalb braucht
 *    diese Funktion die Mints; ohne sie läge jede Bin-Zuordnung falsch herum.
 * 2. **Wo die Gebührenrate herkommt.** `effectiveFeePct` entscheidet das nach
 *    einer Genauigkeits-Rangfolge und liefert `null`, wenn nichts belegt ist.
 *    Dann bucht die Simulation keine Gebühren, statt eine Zahl zu erfinden.
 */
export function marketTickFromPoint(point: TrackPoint, pool: TickPool): MarketTick | null {
  const price = poolPriceInSol({ ...pool, priceNative: point.priceNative ?? undefined });
  if (price === null || price <= 0) return null;

  const feePct = effectiveFeePct(point);
  const protocolFeePct = point.protocolFeePct;

  return {
    priceInSol: price,
    // Fehlender TVL oder SOL-Kurs heißt: Der Gebührenanteil ist nicht
    // bestimmbar. Die Engine bucht bei 0 keine Gebühren — gewollt, siehe
    // KONZEPT-ML.md 5.1.
    poolTvlUsd: point.tvlUsd ?? 0,
    poolVolume24hUsd: point.volume24hUsd ?? 0,
    poolFeePct: feePct ?? 0,
    solPriceUsd: point.solPriceUsd ?? 0,
    ...(protocolFeePct !== undefined && protocolFeePct !== null ? { protocolFeePct } : {}),
    at: point.ts,
  };
}
