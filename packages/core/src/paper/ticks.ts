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
  return rateFromWindows(pool.volumeUsd, FAST_WINDOWS) ?? pool.volume24hUsd ?? 0;
}

/** Zeitfenster vom kürzesten zum trägsten, mit ihrem Hochrechnungsfaktor. */
const FAST_WINDOWS: [keyof PoolMetrics["volumeUsd"], number][] = [
  ["m30", 48],
  ["h1", 24],
  ["h2", 12],
  ["h4", 6],
  ["h12", 2],
  ["h24", 1],
];

const SLOW_WINDOWS = [...FAST_WINDOWS].reverse();

/** Erstes belegtes Fenster der Liste, hochgerechnet auf eine 24-Stunden-Rate. */
function rateFromWindows(
  windows: PoolMetrics["volumeUsd"] | undefined,
  order: [keyof PoolMetrics["volumeUsd"], number][],
): number | null {
  if (windows === undefined) return null;
  for (const [window, factor] of order) {
    const value = windows[window];
    if (value !== undefined && Number.isFinite(value)) return value * factor;
  }
  return null;
}

/**
 * Dasselbe als 24-Stunden-Rate, aber aus dem **trägsten** belegten Fenster.
 *
 * Gegenstück zu `volumeRate24hUsd`, und der Unterschied ist kein Detail: Für
 * den Gebühren-Akkrual über 15 Minuten ist die schnellste verfügbare Auflösung
 * richtig. Für eine Projektion über Stunden ist sie falsch — eine halbstündige
 * Volumenspitze als Dauerannahme zu lesen, überschätzt jeden erwarteten Ertrag
 * um Größenordnungen (ANALYSE.md 4.1). Wer in die Zukunft rechnet, nimmt den
 * trägen Wert.
 */
export function volumeRate24hUsdSlow(pool: PoolMetrics): number {
  return rateFromWindows(pool.volumeUsd, SLOW_WINDOWS) ?? pool.volume24hUsd ?? 0;
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

/**
 * Träge 24-Stunden-Volumenrate einer aufgezeichneten Beobachtung.
 *
 * Die Reihenfolge ist eine Rangfolge nach Trägheit: das gleitende Fenster, das
 * `loadHistory` über die Kerzen legt, dann die Zeitfenster eines Messpunkts,
 * zuletzt der Messwert selbst.
 *
 * **Ohne diesen Wert lief die EV-Prüfung des Rebalancings im Replay in genau den
 * Fehler, für den `poolVolume24hUsdSlow` gebaut wurde** — und zwar schlimmer als
 * live: Eine Kerze ist eine Menge über fünf Minuten, mal 288 auf einen Tag
 * hochgerechnet. Diese Zahl über `projectionHours` zu projizieren erklärt eine
 * Fünf-Minuten-Spitze zur Dauerannahme über zwölf Stunden.
 */
function slowVolumeRateOf(point: TrackPoint): number | undefined {
  if (point.volume24hUsdSlow !== null && point.volume24hUsdSlow !== undefined) {
    return point.volume24hUsdSlow;
  }
  const fromWindows = rateFromWindows(point.windows?.volume, SLOW_WINDOWS);
  if (fromWindows !== null) return fromWindows;
  return point.volume24hUsd ?? undefined;
}

/**
 * Höchst- und Tiefstkurs einer Beobachtung, in SOL.
 *
 * Die Umrechnung ist dieselbe wie beim Schlusskurs — und **sie kann die
 * Reihenfolge umkehren**: Steht SOL auf der X-Seite, ist der Preis in SOL
 * `1/price_native`, und aus dem Höchstkurs wird der Tiefstkurs. Wer hier nur
 * umrechnet und nicht neu ordnet, vertauscht bei jedem SOL/X-Pool Hoch und Tief
 * und lässt damit den Stop-Loss gegen das Hoch prüfen.
 */
function extremesInSol(
  point: TrackPoint,
  pool: TickPool,
): { priceHigh?: number; priceLow?: number } {
  const ends = [point.high, point.low]
    .map((value) => poolPriceInSol({ ...pool, priceNative: value ?? undefined }))
    .filter((value): value is number => value !== null && value > 0);
  if (ends.length === 0) return {};
  return { priceHigh: Math.max(...ends), priceLow: Math.min(...ends) };
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
    poolVolume24hUsdSlow: volumeRate24hUsdSlow(pool),
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
  const slow = slowVolumeRateOf(point);

  return {
    priceInSol: price,
    // Fehlender TVL oder SOL-Kurs heißt: Der Gebührenanteil ist nicht
    // bestimmbar. Die Engine bucht bei 0 keine Gebühren — gewollt, siehe
    // KONZEPT-ML.md 5.2.
    poolTvlUsd: point.tvlUsd ?? 0,
    poolVolume24hUsd: point.volume24hUsd ?? 0,
    ...(slow !== undefined ? { poolVolume24hUsdSlow: slow } : {}),
    ...extremesInSol(point, pool),
    poolFeePct: feePct ?? 0,
    solPriceUsd: point.solPriceUsd ?? 0,
    ...(protocolFeePct !== undefined && protocolFeePct !== null ? { protocolFeePct } : {}),
    at: point.ts,
  };
}
