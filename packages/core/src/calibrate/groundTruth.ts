import type { GlobalConfig, PresetConfig } from "../config/schema";
import type { RealPosition } from "../domain/types";
import type { TrackPoint } from "../ml/outcomes";
import { replayPosition, type ReplayPool } from "../replay/engine";

/**
 * Ground Truth: die Engine an **echten** Positionen messen.
 *
 * **Warum das nötig ist.** Bis hierher konnte sich die Simulation nur mit sich
 * selbst vergleichen. Der Replay prüft, ob die Engine ihre eigenen Regeln
 * konsistent anwendet — er kann nicht prüfen, ob ihre Annahmen stimmen. Drei
 * davon wirken gemeinsam als ein Faktor unbekannter Größe auf der **gesamten**
 * Ertragsseite:
 *
 * - `poolLiquidityBins` — wie eng die übrigen LPs liegen (Faktor 14 zwischen
 *   den plausiblen Extremen),
 * - `feeShareHaircutPct` — der pauschale Sicherheitsabschlag,
 * - `limitOrderShareHaircutPct` — was Order-Liquidität abzweigt.
 *
 * Kein noch so sauberer Replay findet diesen Faktor, weil er in keiner
 * aufgezeichneten Zeitreihe steht. Fremde Positionen schließen die Lücke: Sie
 * hatten eine bekannte Range, einen bekannten Einsatz und einen bekannten
 * Gebührenertrag über einen bekannten Zeitraum. Dieselbe Zeitspanne durch die
 * eigene Engine zu schicken und die Gebühren zu vergleichen, ersetzt drei
 * Schätzungen durch **eine Messung** — ohne eigenes Kapital, ohne RPC-Zugang.
 *
 * **Was dabei nicht herauskommt.** Die drei Annahmen lassen sich damit nicht
 * einzeln bestimmen; sie sind aus einer Beobachtung nicht unterscheidbar. Was
 * herauskommt, ist ihr **Produkt** — und genau das ist die Größe, die zählt:
 * Ob die Simulation um Faktor 3 zu großzügig oder zu streng rechnet, entscheidet
 * über jede Aussage zur Profitabilität. Welche der drei Annahmen den Fehler
 * trägt, ist demgegenüber zweitrangig und braucht den RPC-Adapter.
 */

/** Was ein Vergleichsfall braucht: die reale Position und ihr Marktverlauf. */
export interface CalibrationInput {
  position: RealPosition;
  /** Zeitreihe des Pools; wird auf die Lebensdauer der Position beschnitten. */
  series: TrackPoint[];
  pool: ReplayPool;
}

export interface CalibrationCase {
  positionAddress: string;
  poolAddress: string;
  openedAt: Date;
  hours: number;
  depositSol: number;
  binWidth: number;
  measuredFeesSol: number;
  modelledFeesSol: number;
  /**
   * Gemessen geteilt durch modelliert.
   *
   * Über 1 heißt: Die Simulation rechnet den Gebührenertrag zu **niedrig** und
   * unterschätzt damit die Strategie. Unter 1 heißt das Gegenteil — und das ist
   * der gefährlichere Fall, weil er eine Strategie besser aussehen lässt, als
   * sie ist.
   */
  factor: number;
  ticks: number;
}

export interface SkippedCase {
  positionAddress: string;
  reason: string;
}

export interface CalibrationResult {
  cases: CalibrationCase[];
  skipped: SkippedCase[];
  /**
   * Median des Faktors — die eine Zahl, die sagt, wie weit das Modell danebenliegt.
   *
   * Median statt Mittelwert: Einzelne Positionen mit sehr kurzer Laufzeit oder
   * lückenhafter Historie erzeugen Ausreißer, und die sollen den Befund nicht
   * tragen.
   */
  medianFactor: number | null;
}

/**
 * Bin-Zahlen, über die die Suche nach dem passenden `poolLiquidityBins` läuft.
 *
 * Bewusst grob und logarithmisch gestuft: Die Größe ist eine Annahme über
 * fremdes Verhalten, keine physikalische Konstante. Eine feinere Auflösung
 * täuschte eine Genauigkeit vor, die die Datenlage nicht hergibt.
 */
export const POOL_LIQUIDITY_BIN_GRID = [5, 10, 15, 20, 30, 45, 70, 100, 140, 200, 280, 400];

/**
 * Preset für einen Kalibrierungslauf: feste Breite, keine Ausstiege.
 *
 * **Beides ist notwendig, damit der Vergleich einer ist.** Die reale Position
 * hatte eine bestimmte Range und lief bis zu ihrem Ende; würde die Simulation
 * nach eigenen Regeln früher aussteigen oder nachzentrieren, verglichen wir
 * Gebühren über verschiedene Zeiträume und verschiedene Geometrien. Gemessen
 * werden soll aber **nur** der Gebührenanteil — alles andere ist hier Störgröße.
 *
 * Die Ausstiegsschwellen werden deshalb an ihre Extremwerte gesetzt statt
 * abgeschaltet: Das Schema kennt keinen Aus-Zustand, und ein `stopLossPct` von
 * 90 % zusammen mit Sturz-Schwellen von 95 % greift innerhalb der betrachteten
 * Zeiträume praktisch nie.
 */
export function calibrationPreset(
  preset: PresetConfig,
  binWidth: number,
  holdHours: number,
): PresetConfig {
  return {
    ...preset,
    // Feste Breite: `binRange.min === max` und kein `coverageSigmas` heißt,
    // dass `deriveBinWidth` genau diesen Wert liefert.
    binRange: { min: binWidth, max: binWidth },
    stopLossPct: 90,
    maxHoldHours: Math.min(Math.max(Math.ceil(holdHours) + 1, 1), 24 * 90),
    rebalance: { ...preset.rebalance, enabled: false },
    exit: {
      priceCrashPct: 95,
      priceWindowMin: 5,
      tvlDrainPct: 95,
      tvlWindowMin: 5,
      feeCollapsePct: 99,
      feeStallHours: 24 * 14,
      feeStallMinPctPerDay: 0,
    },
  };
}

/** Kleinste und größte Bin-Zahl, die das Schema zulässt. */
const MIN_BIN_WIDTH = 1;
const MAX_BIN_WIDTH = 1_400;

/**
 * Stellt jede reale Position einem Replay derselben Zeitspanne gegenüber.
 *
 * Ein Fall wird **übersprungen** statt geschätzt, wenn eine der Angaben fehlt,
 * die den Vergleich erst zu einem machen: Bin-Range, Einsatz, Gebührenertrag
 * oder ein verwertbarer Verlauf. Ein Vergleich auf geratener Grundlage wäre
 * schlimmer als kein Vergleich — er sähe aus wie eine Messung.
 */
export function calibrate(
  inputs: CalibrationInput[],
  options: { preset: PresetConfig; global: GlobalConfig },
): CalibrationResult {
  const cases: CalibrationCase[] = [];
  const skipped: SkippedCase[] = [];

  for (const input of inputs) {
    const outcome = calibrateOne(input, options);
    if ("reason" in outcome) skipped.push(outcome);
    else cases.push(outcome);
  }

  return {
    cases,
    skipped,
    medianFactor: median(cases.map((entry) => entry.factor)),
  };
}

/**
 * Sucht den `poolLiquidityBins`-Wert, der die gemessenen Gebühren am besten
 * trifft.
 *
 * Gesucht wird über das **Verhältnis**, nicht über die Differenz: Ein Modell,
 * das um Faktor 2 zu hoch liegt, ist genauso falsch wie eines, das um Faktor 2
 * zu niedrig liegt, und eine absolute Differenz gewichtete große Positionen
 * still stärker als kleine.
 *
 * `null`, wenn kein Gitterpunkt einen brauchbaren Fall erzeugt.
 */
export function fitPoolLiquidityBins(
  inputs: CalibrationInput[],
  options: { preset: PresetConfig; global: GlobalConfig },
  grid: readonly number[] = POOL_LIQUIDITY_BIN_GRID,
): { poolLiquidityBins: number; medianFactor: number } | null {
  let best: { poolLiquidityBins: number; medianFactor: number } | null = null;

  for (const poolLiquidityBins of grid) {
    const result = calibrate(inputs, {
      ...options,
      global: {
        ...options.global,
        paper: { ...options.global.paper, poolLiquidityBins },
      },
    });
    if (result.medianFactor === null || result.medianFactor <= 0) continue;

    const miss = Math.abs(Math.log(result.medianFactor));
    if (best === null || miss < Math.abs(Math.log(best.medianFactor))) {
      best = { poolLiquidityBins, medianFactor: result.medianFactor };
    }
  }

  return best;
}

function calibrateOne(
  input: CalibrationInput,
  options: { preset: PresetConfig; global: GlobalConfig },
): CalibrationCase | SkippedCase {
  const { position, pool } = input;
  const skip = (reason: string): SkippedCase => ({
    positionAddress: position.positionAddress,
    reason,
  });

  if (position.minBinId === undefined || position.maxBinId === undefined) {
    return skip("keine Bin-Range in der Antwort — ohne sie ist die Breite geraten");
  }
  const binWidth = position.maxBinId - position.minBinId + 1;
  if (binWidth < MIN_BIN_WIDTH || binWidth > MAX_BIN_WIDTH) {
    return skip(`Bin-Breite ${binWidth} außerhalb des zulässigen Bereichs`);
  }

  if (position.depositSol === null || position.depositSol <= 0) {
    return skip("kein SOL-denominierter Einsatz");
  }
  if (position.feesSol === null || position.feesSol < 0) {
    return skip("kein SOL-denominierter Gebührenertrag");
  }
  if (position.openedAt === null) return skip("kein Eröffnungszeitpunkt");

  // Nur die Lebensdauer der Position: Gebühren davor und danach gehören ihr
  // nicht, und ein Replay über einen längeren Zeitraum wäre kein Vergleich.
  const until = position.closedAt ?? lastTimestamp(input.series);
  if (until === null || until.getTime() <= position.openedAt.getTime()) {
    return skip("kein auswertbarer Zeitraum");
  }
  const window = input.series.filter(
    (point) =>
      point.ts.getTime() >= position.openedAt!.getTime() &&
      point.ts.getTime() <= until.getTime(),
  );
  if (window.length < 2) return skip("zu wenige Beobachtungen im Zeitraum");

  const hours = (until.getTime() - position.openedAt.getTime()) / 3_600_000;
  const replayed = replayPosition(window, pool, {
    preset: calibrationPreset(options.preset, binWidth, hours),
    global: options.global,
    depositSol: position.depositSol,
  });
  if (replayed === null) return skip("kein verwertbarer Tick im Zeitraum");

  const modelledFeesSol =
    replayed.state.feesClaimedSol + replayed.state.feesUnclaimedSol;
  if (modelledFeesSol <= 0) {
    return skip("Simulation bucht keine Gebühren (fehlender TVL oder SOL-Kurs?)");
  }

  return {
    positionAddress: position.positionAddress,
    poolAddress: position.poolAddress,
    openedAt: position.openedAt,
    hours,
    depositSol: position.depositSol,
    binWidth,
    measuredFeesSol: position.feesSol,
    modelledFeesSol,
    factor: position.feesSol / modelledFeesSol,
    ticks: replayed.ticks,
  };
}

function lastTimestamp(series: TrackPoint[]): Date | null {
  let latest: Date | null = null;
  for (const point of series) {
    if (latest === null || point.ts.getTime() > latest.getTime()) latest = point.ts;
  }
  return latest;
}

function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}
