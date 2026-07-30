import type { GlobalConfig, PresetConfig } from "../config/schema";

/**
 * Einsatz je Position — **die einzige Stelle, die das beantwortet.**
 *
 * Vorher gab es drei Rechnungen mit zwei Ergebnissen: Paper-Engine und Replay
 * nahmen `paper.capitalPerPresetSol × positionSizePct`, der Screening-Filter
 * `global.maxTotalExposureSol × positionSizePct`. Der Filter prüfte damit eine
 * doppelt so große Position, wie die Simulation eröffnete (ANALYSE.md 4.2).
 * Solche Abweichungen fallen nicht auf, weil beide Zahlen für sich plausibel
 * aussehen — deshalb gibt es sie hier nur noch einmal.
 */
export function positionSizeSol(preset: PresetConfig): number {
  return preset.positionSizeSol;
}

/** Was ein Preset bei voller Auslastung einsetzt. */
export function deployedCapitalSol(preset: PresetConfig): number {
  return preset.positionSizeSol * preset.maxPositions;
}

/**
 * Nicht erstattete On-Chain-Fixkosten je Positionslebenszyklus in SOL.
 *
 * Bewusst ohne Rent (~0,057 SOL): Sie kommt beim Schließen zurück und ist
 * gebundenes Kapital, kein Aufwand. Für die Frage, ob eine Positionsgröße
 * überhaupt tragfähig ist, zählt sie trotzdem — dafür gibt es `rentBindingSol`.
 */
export function fixedCostSol(global: GlobalConfig, txCount = 10): number {
  return global.paper.costs.priorityFeeSol * txCount;
}

/** Rent-Bindung je offener Position (DLMM-Positionskonto). */
export const RENT_BINDING_SOL = 0.057;

/**
 * Mögliche Bin-Array-Initialisierung, **nicht erstattet**. Fällt nur an, wenn
 * der gewählte Preisbereich noch nie Liquidität hatte — in aktiven Pools selten,
 * aber bei frischen Memecoin-Pools und weiten Ranges keineswegs ausgeschlossen.
 */
export const BIN_ARRAY_INIT_SOL = 0.075;

export interface SizeViability {
  positionSizeSol: number;
  /** Nicht erstattete Fixkosten in % des Einsatzes. */
  fixedCostPct: number;
  /** Rent-Bindung in % des Einsatzes (kommt zurück, bindet aber Kapital). */
  rentBindingPct: number;
  /** Fixkosten inkl. einer Bin-Array-Initialisierung, in % des Einsatzes. */
  worstCasePct: number;
  viable: boolean;
}

/**
 * Trägt eine Positionsgröße ihre eigenen On-Chain-Fixkosten?
 *
 * Der Maßstab: Nicht erstattete Fixkosten sollen unter 2 % des Einsatzes
 * bleiben, im ungünstigen Fall (mit Bin-Array-Initialisierung) unter 5 %.
 * Darüber ist die Position vor dem ersten Tick im Rückstand — bei den früheren
 * 0,1–0,3 SOL lagen allein Rent-Bindung und eine Initialisierung im Bereich von
 * 50 bis 130 % des Einsatzes.
 */
export function assessSize(preset: PresetConfig, global: GlobalConfig): SizeViability {
  const size = positionSizeSol(preset);
  const fixed = fixedCostSol(global);
  const fixedCostPct = (fixed / size) * 100;
  const worstCasePct = ((fixed + BIN_ARRAY_INIT_SOL) / size) * 100;
  return {
    positionSizeSol: size,
    fixedCostPct,
    rentBindingPct: (RENT_BINDING_SOL / size) * 100,
    worstCasePct,
    viable: fixedCostPct <= 2 && worstCasePct <= 5,
  };
}
