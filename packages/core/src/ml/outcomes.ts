/**
 * Ergebnis-Labels eines Kandidaten (KONZEPT-ML.md Abschnitt 3.2).
 *
 * Strikt getrennt von den Merkmalen: Merkmale beschreiben den
 * Entscheidungszeitpunkt, Labels ausschließlich die Zeit danach. Diese Trennung
 * ist die einzige Absicherung gegen Look-Ahead-Bias.
 */

/** Auswertungshorizonte in Stunden. */
export const OUTCOME_HORIZONS_HOURS = [1, 6, 24, 72, 168] as const;
export type OutcomeHorizon = (typeof OUTCOME_HORIZONS_HOURS)[number];

/** Eine Beobachtung der Zeitreihe eines Pools. */
export interface TrackPoint {
  ts: Date;
  priceNative: number | null;
  tvlUsd: number | null;
  fees24hUsd: number | null;
  volume24hUsd: number | null;
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

    // Tiefster Punkt im Fenster relativ zum Start.
    let maxDrawdownPct: number | null = null;
    if (basePrice !== null && basePrice > 0) {
      for (const point of window) {
        if (point.priceNative === null) continue;
        const change = ((point.priceNative - basePrice) / basePrice) * 100;
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
export function trackingIntervalSec(ageHours: number): number {
  if (ageHours < 48) return 15 * 60;
  return 60 * 60;
}

/** Wie lange ein Pool nach der Entdeckung verfolgt wird. */
export const TRACKING_DURATION_HOURS = 7 * 24;
