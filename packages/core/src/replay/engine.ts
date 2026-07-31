import type { GlobalConfig, PresetConfig } from "../config/schema";
import type { TrackPoint } from "../ml/outcomes";
import { marketTickFromPoint, type TickPool } from "../paper/ticks";
import {
  closePaperPosition,
  openPaperPosition,
  tickPaperPosition,
  valuePosition,
} from "../paper/engine";
import { poolFeeRatePctPerDay } from "../paper/poolHealth";
import { positionSizeSol } from "../paper/sizing";
import { realizedVolatilityPctDaily } from "../ml/volatility";
import type { PaperCloseReason, PaperPositionState, PaperValuation } from "../paper/types";

/**
 * Replay: aufgezeichnete Verläufe durch die Paper-Engine schicken
 * (KONZEPT-ML.md Abschnitt 5).
 *
 * Der Zweck ist der Multiplikator. Real eröffnete Positionen sind selten — ein
 * paar hundert in Wochen. Auf denselben Verläufen lassen sich Einstiege an
 * **beliebigen** Zeitpunkten simulieren, und jede Parameterkombination
 * beliebig oft. Aus Kalenderzeit wird Rechenzeit.
 *
 * Zwei Eigenschaften, ohne die das wertlos wäre:
 *
 * - **Ein Codepfad.** Dieses Modul enthält keine eigene Positionslogik. Es ruft
 *   `openPaperPosition`, `tickPaperPosition` und `closePaperPosition` — dieselben
 *   Funktionen, die im Paper-Betrieb laufen. Sobald es zwei Implementierungen
 *   gäbe, optimierte man gegen die eine und handelte mit der anderen.
 * - **Determinismus.** Keine Wanduhr, kein Zufall. Jede Zeitangabe stammt aus
 *   den Daten. Derselbe Verlauf und dieselben Parameter ergeben dasselbe
 *   Ergebnis, sonst ist keine Optimierung reproduzierbar.
 */

export interface ReplayPool extends TickPool {
  poolAddress: string;
  binStep: number;
}

export interface ReplayOptions {
  preset: PresetConfig;
  global: GlobalConfig;
  /** Einsatz in SOL; Default ist der Preset-Anteil am virtuellen Kapital. */
  depositSol?: number;
  /**
   * Rückblick für die Volatilitätsschätzung in Stunden.
   *
   * Steuert, wie viel Vergangenheit die Range-Breite bestimmt. Kürzer heißt
   * reaktiver und verrauschter, länger heißt träger. 24 Stunden entsprechen dem
   * Horizont, auf den `deriveBinWidth` normiert.
   */
  volatilityLookbackHours?: number;
}

/**
 * Rückblick der Volatilitätsschätzung — bewusst **nur nach hinten**.
 *
 * Der Replay hat die gesamte Zeitreihe im Speicher, auch die Zukunft. Sie für
 * die Range-Breite zu benutzen wäre Look-Ahead-Bias in seiner reinsten Form:
 * Die Position wüsste beim Eröffnen, wie wild es gleich wird. Das Ergebnis sähe
 * hervorragend aus und wäre wertlos.
 */
const DEFAULT_VOLATILITY_LOOKBACK_HOURS = 24;

/**
 * Volatilitätsschätzung zum Einstiegszeitpunkt aus den Punkten davor.
 *
 * **Warum es diese Funktion gibt.** Der Replay rief `openPaperPosition` ohne
 * `volatilityPctDaily` — und damit fiel `deriveBinWidth` auf die Mitte von
 * `binRange` zurück. Der Replay simulierte also eine feste Bin-Zahl, während
 * live die aus der Volatilität hergeleitete Breite läuft: bei einem ruhigen
 * Pool eine mehr als dreifach zu breite Position. Der eigene Anteil am aktiven
 * Bin skaliert mit 1/Breite, der Gebührenertrag wich damit um denselben Faktor
 * ab. Jede Kalibrierung über den Replay maß eine andere Strategie als die, die
 * gehandelt wird — genau das, was „ein Codepfad" verhindern soll.
 *
 * Gemessen wird mit `realizedVolatilityPctDaily` auf der aufgezeichneten Reihe.
 * Das ist die genauere der beiden Schätzungen; live steht im Scan-Pfad nur die
 * gröbere aus den DexScreener-Preisänderungen zur Verfügung, weil ein frisch
 * entdeckter Pool noch keine eigene Aufzeichnung hat.
 */
function volatilityAt(
  series: TrackPoint[],
  index: number,
  lookbackHours: number,
): number | null {
  const until = series[index]?.ts.getTime();
  if (until === undefined) return null;
  const from = until - lookbackHours * 3_600_000;

  const window: TrackPoint[] = [];
  for (let i = index; i >= 0; i--) {
    const point = series[i]!;
    if (point.ts.getTime() < from) break;
    window.push(point);
  }
  return realizedVolatilityPctDaily(window);
}

/**
 * Warum eine simulierte Position endete.
 *
 * `end_of_series` ist kein Ausstiegsgrund, sondern das Ende der Daten: Die
 * Position war noch offen, als der Verlauf abriss. Solche Beobachtungen sind
 * **rechtszensiert** und dürfen nicht wie abgeschlossene gezählt werden — sonst
 * erscheint jede Strategie besser, die ihre Verlierer lange hält.
 */
export type ReplayCloseReason = PaperCloseReason | "end_of_series";

export interface ReplayPosition {
  poolAddress: string;
  entryAt: Date;
  exitAt: Date;
  closeReason: ReplayCloseReason;
  /** Rechtszensiert: am Datenende abgeschnitten statt regulär beendet. */
  censored: boolean;
  valuation: PaperValuation;
  state: PaperPositionState;
  /** Verarbeitete Beobachtungen nach dem Einstieg. */
  ticks: number;
}

/**
 * Spielt **eine** Position ab dem angegebenen Punkt der Zeitreihe durch.
 *
 * `null`, wenn ab dort kein verwertbarer Tick mehr kommt — ohne Preis lässt sich
 * nichts eröffnen.
 */
export function replayPosition(
  series: TrackPoint[],
  pool: ReplayPool,
  options: ReplayOptions,
  startIndex = 0,
): ReplayPosition | null {
  const entry = nextUsableTick(series, pool, startIndex);
  if (entry === null) return null;

  const { preset, global } = options;
  const depositSol = options.depositSol ?? positionSizeSol(preset);

  let state = openPaperPosition({
    preset,
    global,
    binStep: pool.binStep,
    price: entry.tick.priceInSol,
    depositSol,
    feePct: entry.tick.poolFeePct,
    feeRatePctPerDay: poolFeeRatePctPerDay(
      entry.tick.poolVolume24hUsd,
      entry.tick.poolFeePct,
      entry.tick.poolTvlUsd,
    ),
    // Aus der Vergangenheit vor dem Einstieg — nie aus der Reihe danach.
    volatilityPctDaily: volatilityAt(
      series,
      entry.index,
      options.volatilityLookbackHours ?? DEFAULT_VOLATILITY_LOOKBACK_HOURS,
    ),
    at: entry.tick.at,
  });

  let valuation = valuePosition(state, entry.tick.priceInSol);
  let closeReason: ReplayCloseReason = "end_of_series";
  let lastPrice = entry.tick.priceInSol;
  let exitAt = entry.tick.at;
  let ticks = 0;

  for (let i = entry.index + 1; i < series.length; i++) {
    const tick = marketTickFromPoint(series[i]!, pool);
    if (tick === null) continue;

    const result = tickPaperPosition(state, tick, preset, global);
    state = result.state;
    valuation = result.valuation;
    lastPrice = tick.priceInSol;
    exitAt = tick.at;
    ticks++;

    if (result.closeReason !== null) {
      closeReason = result.closeReason;
      break;
    }
  }

  // Auch die zensierte Position wird geschlossen — sonst fehlten ihr die
  // Ausstiegskosten und sie sähe systematisch besser aus als eine beendete.
  const closed = closePaperPosition(state, lastPrice, global);

  return {
    poolAddress: pool.poolAddress,
    entryAt: entry.tick.at,
    exitAt,
    closeReason,
    censored: closeReason === "end_of_series",
    valuation: closed.valuation,
    state: closed.state,
    ticks,
  };
}

export interface ReplaySweepOptions extends ReplayOptions {
  /**
   * Abstand zwischen zwei Einstiegen in Minuten.
   *
   * Der Regler zwischen Menge und Unabhängigkeit: Einstiege im Minutentakt
   * liefern viele Positionen, die einander stark überlappen und damit fast
   * dieselbe Beobachtung mehrfach zählen. Der Default entspricht einer Stunde.
   */
  everyMinutes?: number;
  /** Obergrenze, damit ein langer Verlauf nicht unbemerkt explodiert. */
  maxPositions?: number;
}

const DEFAULT_ENTRY_SPACING_MIN = 60;
const DEFAULT_MAX_POSITIONS = 500;

/**
 * Eröffnet über den Verlauf hinweg regelmäßig Positionen.
 *
 * Das ist die Antwort auf „zu wenige Beobachtungen": Aus einem Verlauf entstehen
 * so viele Positionen, wie man Einstiege setzt — ohne dafür Kalenderzeit zu
 * brauchen.
 */
export function replayEntries(
  series: TrackPoint[],
  pool: ReplayPool,
  options: ReplaySweepOptions,
): ReplayPosition[] {
  const spacingMs = (options.everyMinutes ?? DEFAULT_ENTRY_SPACING_MIN) * 60_000;
  const maxPositions = options.maxPositions ?? DEFAULT_MAX_POSITIONS;

  const positions: ReplayPosition[] = [];
  let nextEntryMs = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < series.length && positions.length < maxPositions; i++) {
    const point = series[i]!;
    const ts = point.ts.getTime();
    if (ts < nextEntryMs) continue;

    const position = replayPosition(series, pool, options, i);
    if (position === null) break;

    positions.push(position);
    // Am tatsächlichen Einstieg ausrichten, nicht am Rasterpunkt: Sonst
    // verschiebt eine Lücke in den Daten alle folgenden Einstiege.
    nextEntryMs = position.entryAt.getTime() + spacingMs;
  }

  return positions;
}

export interface ReplaySummary {
  positions: number;
  /** Regulär beendet — nur diese tragen Trefferquote und Ausstiegsgründe. */
  decided: number;
  /** Am Datenende abgeschnitten (rechtszensiert). */
  censored: number;
  wins: number;
  winRatePct: number | null;
  totalPnlSol: number;
  /** Median statt Mittelwert: Ein Glückstreffer soll nichts entscheiden. */
  medianPnlPct: number | null;
  feesSol: number;
  costsSol: number;
  vsHodlSol: number;
  avgTimeInRangePct: number | null;
  /** Wie oft welcher Ausstiegsgrund griff — der Blick in die Mechanik. */
  closeReasons: Record<string, number>;
}

/**
 * Kennzahlen eines Replay-Laufs.
 *
 * Zensierte Positionen fließen in Erträge und Kosten ein (sie haben ja
 * stattgefunden), aber **nicht** in Trefferquote und Ausstiegsgründe: Ob sie
 * gewonnen hätten, weiß niemand.
 */
export function summarizeReplay(positions: ReplayPosition[]): ReplaySummary {
  const decided = positions.filter((position) => !position.censored);
  const wins = decided.filter((position) => position.valuation.pnlSol > 0).length;

  const closeReasons: Record<string, number> = {};
  for (const position of decided) {
    closeReasons[position.closeReason] = (closeReasons[position.closeReason] ?? 0) + 1;
  }

  const inRange = positions
    .map((position) => position.valuation.timeInRangePct)
    .filter((value) => Number.isFinite(value));

  return {
    positions: positions.length,
    decided: decided.length,
    censored: positions.length - decided.length,
    wins,
    winRatePct: decided.length > 0 ? (wins / decided.length) * 100 : null,
    totalPnlSol: sum(positions.map((position) => position.valuation.pnlSol)),
    medianPnlPct: median(positions.map((position) => position.valuation.pnlPct)),
    feesSol: sum(
      positions.map(
        (position) => position.state.feesClaimedSol + position.state.feesUnclaimedSol,
      ),
    ),
    costsSol: sum(positions.map((position) => position.state.costsSol)),
    vsHodlSol: sum(positions.map((position) => position.valuation.vsHodlSol)),
    avgTimeInRangePct: inRange.length > 0 ? sum(inRange) / inRange.length : null,
    closeReasons,
  };
}

/** Erster Punkt ab `from`, aus dem sich ein Tick bauen lässt. */
function nextUsableTick(
  series: TrackPoint[],
  pool: TickPool,
  from: number,
): { tick: NonNullable<ReturnType<typeof marketTickFromPoint>>; index: number } | null {
  for (let i = Math.max(0, from); i < series.length; i++) {
    const tick = marketTickFromPoint(series[i]!, pool);
    if (tick !== null) return { tick, index: i };
  }
  return null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function median(values: number[]): number | null {
  const usable = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (usable.length === 0) return null;
  const mid = Math.floor(usable.length / 2);
  if (usable.length % 2 === 1) return usable[mid]!;
  return (usable[mid - 1]! + usable[mid]!) / 2;
}
