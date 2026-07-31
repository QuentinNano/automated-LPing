/**
 * Ergebnis-Labels eines Kandidaten (KONZEPT-ML.md Abschnitt 3.2).
 *
 * Strikt getrennt von den Merkmalen: Merkmale beschreiben den
 * Entscheidungszeitpunkt, Labels ausschließlich die Zeit danach. Diese Trennung
 * ist die einzige Absicherung gegen Look-Ahead-Bias.
 */

import { METRIC_WINDOWS, type WindowedMetric } from "../domain/types";

/** Auswertungshorizonte in Stunden. */
export const OUTCOME_HORIZONS_HOURS = [1, 6, 24, 72, 168] as const;
export type OutcomeHorizon = (typeof OUTCOME_HORIZONS_HOURS)[number];

/**
 * Kennzahlen eines Messpunkts über alle Zeitfenster.
 *
 * Als JSON geführt statt als 24 Spalten: Kommt bei Meteora ein Fenster hinzu,
 * braucht es keine Migration, und der Datensatz bleibt selbstbeschreibend.
 */
export interface SnapshotWindows {
  volume?: WindowedMetric;
  fees?: WindowedMetric;
  feeTvl?: WindowedMetric;
  protocolFees?: WindowedMetric;
}

/** Eine Beobachtung der Zeitreihe eines Pools. */
export interface TrackPoint {
  ts: Date;
  priceNative: number | null;
  /**
   * Höchst- und Tiefstkurs **innerhalb** des Intervalls, falls bekannt.
   *
   * Eine Stichprobe aus der laufenden Aufzeichnung kennt sie nicht — sie sieht
   * nur den Preis zum Messzeitpunkt. Nachgeladene Kerzen liefern sie, und das
   * ist mehr als eine Feinheit: Zwischen zwei Messpunkten kann der Preis eine
   * Range verlassen und zurückkehren, ohne je in einer Stichprobe aufzutauchen.
   * Wo `low` vorliegt, wird der Drawdown gemessen statt geschätzt.
   */
  high?: number | null;
  low?: number | null;
  tvlUsd: number | null;
  fees24hUsd: number | null;
  volume24hUsd: number | null;
  /**
   * Volumen als 24-Stunden-Rate aus einem **trägen** Fenster.
   *
   * Gegenstück zu `volume24hUsd`, das bei Kerzen die Menge eines einzelnen
   * Intervalls hochrechnet (5 Minuten × 288). Für den Gebühren-Akkrual über
   * genau dieses Intervall ist das richtig. Für **Projektionen** über Stunden
   * ist es falsch — dort wird eine Fünf-Minuten-Spitze zur Dauerannahme, und
   * genau das öffnete die EV-Prüfung vor jedem Rebalance.
   *
   * `loadHistory` füllt das Feld mit einem gleitenden Mittel über die
   * zurückliegenden 24 Stunden. Ein Messpunkt braucht es nicht: Seine
   * `windows` enthalten die trägen Fenster bereits.
   */
  volume24hUsdSlow?: number | null;
  /** Gesamtgebühr (Basis + Volatilitätsaufschlag) zum Messzeitpunkt, in %. */
  dynamicFeePct?: number | null;
  baseFeePct?: number | null;
  /** Protokollanteil in % **der Gebühr** — der LP erhält nur den Rest. */
  protocolFeePct?: number | null;
  /**
   * USD-Preis von SOL zum Messzeitpunkt. Der Replay braucht ihn, um den
   * Pool-TVL in SOL umzurechnen — im Bin-Modell kürzt sich der Kurs nicht
   * heraus wie in der früheren TVL-Anteil-Rechnung.
   */
  solPriceUsd?: number | null;
  windows?: SnapshotWindows | null;
}

/**
 * Effektiver Swap-Gebührensatz eines Messpunkts in Prozent — die Größe, mit der
 * die Simulation den Gebührenfluss berechnet.
 *
 * Die Reihenfolge ist eine Genauigkeits-Rangfolge, keine Bequemlichkeit:
 * 1. `dynamicFeePct` — von der API gemeldete Gesamtgebühr zum Messzeitpunkt.
 * 2. Realisierte Rate aus dem kürzesten belegten Fenster (`fees/volume`). Das
 *    ist ein Ist-Wert statt einer Momentaufnahme und deckt auch Pools ab, deren
 *    Gebühr zwischen zwei Messpunkten geschwankt hat.
 * 3. Realisierte Rate über 24 h — träge, aber immer vorhanden.
 * 4. `baseFeePct` als Untergrenze. Unterschätzt volatile Pools deutlich, ist
 *    aber besser als die Position gebührenfrei zu rechnen.
 *
 * `null` heißt: nicht bestimmbar. Dann darf die Simulation keine Gebühren
 * buchen, statt eine Zahl zu erfinden.
 */
export function effectiveFeePct(point: TrackPoint): number | null {
  if (isPositive(point.dynamicFeePct)) return point.dynamicFeePct;

  const windows = point.windows;
  if (windows !== undefined && windows !== null) {
    // Kürzestes Fenster zuerst: es liegt dem Messintervall am nächsten.
    for (const window of METRIC_WINDOWS) {
      const fees = windows.fees?.[window];
      const volume = windows.volume?.[window];
      if (fees !== undefined && volume !== undefined && volume > 0 && fees >= 0) {
        return (fees / volume) * 100;
      }
    }
  }

  if (
    point.fees24hUsd !== null &&
    point.fees24hUsd !== undefined &&
    point.fees24hUsd >= 0 &&
    point.volume24hUsd !== null &&
    point.volume24hUsd !== undefined &&
    point.volume24hUsd > 0
  ) {
    return (point.fees24hUsd / point.volume24hUsd) * 100;
  }

  return isPositive(point.baseFeePct) ? point.baseFeePct : null;
}

function isPositive(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value) && value > 0;
}

export interface OutcomeLabel {
  horizonHours: number;
  /** Preisänderung gegenüber dem Entscheidungszeitpunkt in %. */
  priceChangePct: number | null;
  /** TVL-Änderung in % — abfließende Liquidität ist ein Frühindikator. */
  tvlChangePct: number | null;
  /**
   * Grob geschätzter Gebührenertrag je TVL-Einheit über den Horizont, in %.
   * Aus der laufenden 24h-Fee-Rate hochgerechnet — eine Näherung, kein Ersatz
   * für die Replay-Simulation, aber ausreichend als Lernziel für die Auswahl.
   */
  feeYieldPct: number | null;
  /** Maximaler Preisrückgang innerhalb des Horizonts in %. */
  maxDrawdownPct: number | null;
  /** Preis −90 % oder TVL −90 % gegenüber Start. */
  rugged: boolean;
  /** Wie viele Messpunkte lagen im Horizont? Wenige = unzuverlässiges Label. */
  observations: number;
  /** Tatsächlich abgedeckter Zeitraum in Stunden (Lücken machen ihn kleiner). */
  coveredHours: number;
}

const RUG_THRESHOLD_PCT = -90;

/**
 * Berechnet die Labels eines Kandidaten aus seiner aufgezeichneten Zeitreihe.
 * `points` muss nach Zeit aufsteigend sortiert sein.
 */
export function computeOutcomes(
  decisionAt: Date,
  points: TrackPoint[],
  horizons: readonly number[] = OUTCOME_HORIZONS_HOURS,
): OutcomeLabel[] {
  const startMs = decisionAt.getTime();
  const inOrder = points
    .filter((p) => p.ts.getTime() >= startMs)
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const basePrice = firstDefined(inOrder, (p) => p.priceNative);
  const baseTvl = firstDefined(inOrder, (p) => p.tvlUsd);

  return horizons.map((horizonHours) => {
    const endMs = startMs + horizonHours * 3_600_000;
    const window = inOrder.filter((p) => p.ts.getTime() <= endMs);

    if (window.length === 0) {
      return emptyLabel(horizonHours);
    }

    const last = window[window.length - 1]!;
    const coveredHours = (last.ts.getTime() - startMs) / 3_600_000;

    const endPrice = lastDefined(window, (p) => p.priceNative);
    const endTvl = lastDefined(window, (p) => p.tvlUsd);

    const priceChangePct =
      basePrice !== null && basePrice > 0 && endPrice !== null
        ? ((endPrice - basePrice) / basePrice) * 100
        : null;
    const tvlChangePct =
      baseTvl !== null && baseTvl > 0 && endTvl !== null
        ? ((endTvl - baseTvl) / baseTvl) * 100
        : null;

    // Tiefster Punkt im Fenster relativ zum Start. Wo eine Kerze ihren
    // Tiefstkurs mitbringt, zählt dieser — sonst der Preis zum Messzeitpunkt.
    // Ohne `low` unterschätzt das Label jeden Einbruch, der zwischen zwei
    // Stichproben lag und sich wieder erholt hat.
    let maxDrawdownPct: number | null = null;
    if (basePrice !== null && basePrice > 0) {
      for (const point of window) {
        const trough = lowestOf(point);
        if (trough === null) continue;
        const change = ((trough - basePrice) / basePrice) * 100;
        if (maxDrawdownPct === null || change < maxDrawdownPct) maxDrawdownPct = change;
      }
    }

    return {
      horizonHours,
      priceChangePct,
      tvlChangePct,
      feeYieldPct: estimateFeeYieldPct(window, coveredHours),
      maxDrawdownPct,
      rugged:
        (priceChangePct !== null && priceChangePct <= RUG_THRESHOLD_PCT) ||
        (tvlChangePct !== null && tvlChangePct <= RUG_THRESHOLD_PCT),
      observations: window.length,
      coveredHours,
    };
  });
}

/**
 * Integriert die laufende 24h-Fee-Rate über die Beobachtungen.
 * Jede Messung trägt anteilig zu ihrem Zeitabstand bei — dadurch verzerren
 * ungleichmäßige Abstände (dichtes Raster zu Beginn, später gröber) das
 * Ergebnis nicht.
 */
function estimateFeeYieldPct(window: TrackPoint[], coveredHours: number): number | null {
  if (window.length < 2 || coveredHours <= 0) return null;

  let sum = 0;
  let weighted = false;
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    const current = window[i]!;
    const hours = (current.ts.getTime() - prev.ts.getTime()) / 3_600_000;
    if (hours <= 0) continue;

    // Rate am Intervallanfang, damit kein Wert aus der Zukunft einfließt.
    const rate = ratePerDayPct(prev);
    if (rate === null) continue;
    sum += rate * (hours / 24);
    weighted = true;
  }
  return weighted ? sum : null;
}

function ratePerDayPct(point: TrackPoint): number | null {
  if (point.fees24hUsd === null || point.tvlUsd === null || point.tvlUsd <= 0) return null;
  return (point.fees24hUsd / point.tvlUsd) * 100;
}

function emptyLabel(horizonHours: number): OutcomeLabel {
  return {
    horizonHours,
    priceChangePct: null,
    tvlChangePct: null,
    feeYieldPct: null,
    maxDrawdownPct: null,
    rugged: false,
    observations: 0,
    coveredHours: 0,
  };
}

/** Tiefster bekannter Kurs einer Beobachtung: `low`, sonst der Messwert. */
function lowestOf(point: TrackPoint): number | null {
  const low = point.low;
  if (low !== null && low !== undefined && Number.isFinite(low) && low > 0) return low;
  return point.priceNative !== null && Number.isFinite(point.priceNative)
    ? point.priceNative
    : null;
}

function firstDefined(points: TrackPoint[], get: (p: TrackPoint) => number | null): number | null {
  for (const point of points) {
    const value = get(point);
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

function lastDefined(points: TrackPoint[], get: (p: TrackPoint) => number | null): number | null {
  for (let i = points.length - 1; i >= 0; i--) {
    const value = get(points[i]!);
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Aufzeichnungsraster: die ersten 48 Stunden dicht, danach gröber
 * (KONZEPT-ML.md Abschnitt 3.2). Spart Datenvolumen und API-Aufrufe, ohne die
 * entscheidende Frühphase zu verlieren.
 */
export function trackingIntervalSec(ageHours: number, denseIntervalMin = 15): number {
  // In der Frühphase dicht messen — dort entscheidet sich bei Memecoins das
  // meiste. `denseIntervalMin` folgt dem Zyklus-Intervall des Aufzeichners:
  // Wer häufiger läuft, soll auch feiner auflösen.
  if (ageHours < 48) return Math.max(60, denseIntervalMin * 60);
  // Danach genügt ein gröberes Raster — nie feiner als die Frühphase.
  return Math.max(denseIntervalMin * 60, 60 * 60);
}

/** Wie lange ein Pool nach der Entdeckung verfolgt wird. */
export const TRACKING_DURATION_HOURS = 7 * 24;
