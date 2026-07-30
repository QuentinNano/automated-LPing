import type { ExitConfig } from "../config/schema";

/**
 * Zustandsabhängige Ausstiegsregeln einer offenen Position.
 *
 * **Warum es diese Datei gibt.** Bis hierher hatte eine Position genau zwei
 * PnL-Regeln: Take-Profit und Stop-Loss. Der Take-Profit konnte nicht auslösen —
 * der Preisgewinn einer DLMM-Position ist durch ihre Range gedeckelt (+1,26 %
 * konservativ, +2,18 % balanced, ±0 % einseitig), während die Schwellen bei
 * 30–50 % standen. Übrig blieb ein einseitiges Regelwerk, dessen Median-Ergebnis
 * fast exakt der eingestellte Stop-Loss war (ANALYSE.md 2).
 *
 * Der PnL ist für eine LP-Position ohnehin das nachlaufende Signal. Was sie
 * verdient, hängt an Pool-Größen — Volumen, Gebührenrate, TVL —, und die drehen
 * **vor** dem PnL. Diese Datei prüft deshalb die Frage, die zu einer
 * LP-Position gehört: *verdient sie noch, und ist der Ausstieg noch möglich?*
 *
 * **Warum der PnL-Stop trotzdem bleibt.** Es gibt einen Fall, in dem alle
 * Pool-Größen gesund aussehen und die Position dennoch ausblutet: den Dump. Dort
 * steigt das Volumen, steigt die Gebührenrate, und der TVL kann sogar steigen,
 * weil Farmer Liquidität nachlegen. Ein rein parameterbasierter Ausstieg wäre
 * genau dann blind, wenn es darauf ankommt. Der PnL-Stop macht als einziger
 * keine Annahme über den Mechanismus und bleibt darum als Rückfalllinie stehen —
 * nur weiter gesetzt, damit er nicht länger der einzige Ausgang ist.
 *
 * Alles hier ist pur und deterministisch: gleiche Historie, gleiches Urteil.
 */

/** Eine Beobachtung des Pools zum Zeitpunkt eines Ticks. */
export interface PoolObservation {
  atMs: number;
  priceInSol: number;
  tvlUsd: number;
  /**
   * Gebührenertragsrate des **Pools**: Gebühren je TVL und Tag, in Prozent.
   * Skalenfrei und damit über Pools hinweg vergleichbar.
   */
  feeRatePctPerDay: number;
  /** Kumulierter Gebührenertrag der **Position** in SOL zu diesem Zeitpunkt. */
  feesTotalSol: number;
}

export type PoolExitReason = "price_crash" | "tvl_drain" | "fee_collapse" | "fee_stall";

/**
 * Obergrenze der mitgeführten Beobachtungen.
 *
 * Der Zustand wird als JSON persistiert, die Historie darf also nicht unbegrenzt
 * wachsen. 96 Einträge decken bei 15-Minuten-Raster 24 Stunden ab — mehr braucht
 * keine der Regeln, und ein feineres Raster verkürzt lediglich das abgedeckte
 * Fenster statt den Speicher zu sprengen.
 */
const MAX_OBSERVATIONS = 96;

/** Hängt eine Beobachtung an und verwirft, was keine Regel mehr braucht. */
export function recordObservation(
  history: PoolObservation[],
  observation: PoolObservation,
  exit: ExitConfig,
): PoolObservation[] {
  const horizonMs =
    Math.max(exit.priceWindowMin, exit.tvlWindowMin, exit.feeStallHours * 60) * 60_000;
  const cutoff = observation.atMs - horizonMs;

  const kept = history.filter((point) => point.atMs >= cutoff);
  kept.push(observation);
  return kept.length > MAX_OBSERVATIONS ? kept.slice(kept.length - MAX_OBSERVATIONS) : kept;
}

export interface PoolHealthInput {
  history: PoolObservation[];
  exit: ExitConfig;
  /** Gebührenertragsrate des Pools beim Eröffnen — Bezugsgröße für `fee_collapse`. */
  entryFeeRatePctPerDay: number;
  depositSol: number;
  /** Laufzeit der Position in Millisekunden. */
  ageMs: number;
  /**
   * Hat der Markt die Range je erreicht?
   *
   * Eine einseitige Position liegt beim Eröffnen bewusst außerhalb und wartet
   * dort auf Befüllung. Sie verdient in dieser Zeit per Konstruktion nichts —
   * ein Ertrags-Exit wäre dort kein Befund, sondern eine Fehlmessung. Solange
   * die Range nie erreicht wurde, greift allein das Zeitlimit.
   */
  rangeReached: boolean;
}

/**
 * Erste zutreffende Ausstiegsregel oder `null`.
 *
 * Die Reihenfolge ist die Rangfolge: Risiko-Exits vor Ertrags-Exits. Wer nicht
 * mehr aussteigen kann, hat kein Ertragsproblem mehr.
 */
export function evaluatePoolExit(input: PoolHealthInput): PoolExitReason | null {
  const { history, exit } = input;
  if (history.length < 2) return null;

  const now = history[history.length - 1]!;

  // --- Risiko: Preissturz ---------------------------------------------------
  // Gemessen vom Fensterhoch, nicht vom Einstieg: Ein Sturz ist ein Sturz, auch
  // wenn die Position davor im Plus lag.
  const priceWindow = since(history, now.atMs - exit.priceWindowMin * 60_000);
  const priceHigh = Math.max(...priceWindow.map((p) => p.priceInSol));
  if (priceHigh > 0 && dropPct(priceHigh, now.priceInSol) >= exit.priceCrashPct) {
    return "price_crash";
  }

  // --- Risiko: Liquiditätsabzug --------------------------------------------
  // Abfließender TVL geht Preisverfall oft voraus und verschlechtert zugleich
  // die eigene Ausstiegsfähigkeit — beides spricht für einen frühen Ausstieg.
  const tvlWindow = since(history, now.atMs - exit.tvlWindowMin * 60_000);
  const tvlHigh = Math.max(...tvlWindow.map((p) => p.tvlUsd));
  if (tvlHigh > 0 && dropPct(tvlHigh, now.tvlUsd) >= exit.tvlDrainPct) {
    return "tvl_drain";
  }

  // Ertrags-Exits erst, wenn die Position überhaupt verdienen konnte.
  if (!input.rangeReached) return null;

  // --- Ertrag: der Pool verdient nicht mehr --------------------------------
  // Der Median des Fensters statt des letzten Werts: Die Gebührenrate schwankt
  // auf kurzen Fenstern stark, und eine einzelne ruhige Viertelstunde ist kein
  // Grund, eine funktionierende Position zu schließen.
  if (input.entryFeeRatePctPerDay > 0) {
    const recent = median(tvlWindow.map((p) => p.feeRatePctPerDay));
    if (
      recent !== null &&
      dropPct(input.entryFeeRatePctPerDay, recent) >= exit.feeCollapsePct
    ) {
      return "fee_collapse";
    }
  }

  // --- Ertrag: die Position verdient nicht mehr ----------------------------
  // Anders als `fee_collapse` misst das nicht den Pool, sondern uns: Es greift
  // auch dann, wenn der Pool floriert und nur die eigene Range danebenliegt.
  const stallMs = exit.feeStallHours * 3_600_000;
  if (input.ageMs >= stallMs && input.depositSol > 0) {
    const past = history.find((point) => point.atMs >= now.atMs - stallMs);
    if (past !== undefined && past.atMs < now.atMs) {
      const earnedSol = now.feesTotalSol - past.feesTotalSol;
      const days = (now.atMs - past.atMs) / 86_400_000;
      const ratePctPerDay = days > 0 ? (earnedSol / input.depositSol / days) * 100 : 0;
      if (ratePctPerDay < exit.feeStallMinPctPerDay) return "fee_stall";
    }
  }

  return null;
}

/** Beobachtungen ab einem Zeitpunkt; immer mindestens die jüngste. */
function since(history: PoolObservation[], fromMs: number): PoolObservation[] {
  const window = history.filter((point) => point.atMs >= fromMs);
  return window.length > 0 ? window : [history[history.length - 1]!];
}

/** Rückgang von `from` auf `to` in Prozent; negativ bei Anstieg. */
function dropPct(from: number, to: number): number {
  if (from <= 0) return 0;
  return ((from - to) / from) * 100;
}

function median(values: number[]): number | null {
  const usable = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (usable.length === 0) return null;
  const mid = Math.floor(usable.length / 2);
  if (usable.length % 2 === 1) return usable[mid]!;
  return (usable[mid - 1]! + usable[mid]!) / 2;
}

/**
 * Gebührenertragsrate eines Pools: Gebühren je TVL und Tag, in Prozent.
 *
 * Die eine Größe, die „verdient dieser Pool?" beantwortet, ohne von der eigenen
 * Positionsgröße abzuhängen — und damit die richtige Bezugsgröße für
 * `fee_collapse`.
 */
export function poolFeeRatePctPerDay(
  volume24hUsd: number,
  feePct: number,
  tvlUsd: number,
): number {
  if (tvlUsd <= 0 || volume24hUsd <= 0 || feePct <= 0) return 0;
  return ((volume24hUsd * (feePct / 100)) / tvlUsd) * 100;
}
