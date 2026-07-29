import type { PresetConfig } from "../config/schema";
import type { PoolMetrics } from "../domain/types";
import { tokenSideOf } from "../screening/aggregate";

/**
 * Eigene Replikation der Fabriq-Kategorien (KONZEPT.md Abschnitt 4.1, Weg 2):
 * billiger Vor-Filter auf reinen Meteora-Daten, der die Shortlist für das
 * teure Deep-Screening (DexScreener/RugCheck/Jupiter) bestimmt.
 *
 * Bewusst großzügiger als die Hard Filters (Faktor 0,5–0,75 auf Schwellwerte):
 * Ablehnen ist Aufgabe des Screenings, nicht der Discovery. Das Token-Alter
 * ist hier meist noch unbekannt und wird erst nach dem Enrichment geprüft.
 */
export interface ClassifyResult {
  eligible: boolean;
  reasons: string[];
}

/**
 * Nachlass, den der Vor-Filter gegenüber den Hard Filters gewährt. Wird auch
 * für den serverseitigen Discovery-Filter benutzt — beide müssen denselben Wert
 * verwenden, sonst siebt der Server Kandidaten aus, die das Screening noch
 * sehen wollte.
 */
export const DISCOVERY_THRESHOLD_FACTOR = 0.5;

/**
 * Kleinster TVL, den irgendein aktives Preset noch betrachten würde. Grundlage
 * des serverseitigen `filter_by` — großzügig genug, dass kein Preset dadurch
 * Kandidaten verliert.
 */
export function minTvlAcrossPresets(presets: Record<string, PresetConfig>): number {
  const active = Object.values(presets).filter((preset) => preset.enabled);
  if (active.length === 0) return 0;
  return Math.min(...active.map((preset) => preset.minTvlUsd * DISCOVERY_THRESHOLD_FACTOR));
}

export function classifyForPreset(pool: PoolMetrics, preset: PresetConfig): ClassifyResult {
  const reasons: string[] = [];

  if (tokenSideOf(pool) === null) reasons.push("nicht SOL-quotiert");

  if (pool.binStep < preset.discovery.minBinStep) {
    reasons.push(`binStep ${pool.binStep} < ${preset.discovery.minBinStep}`);
  }

  const baseFee = pool.baseFeePct ?? 0;
  if (baseFee < preset.discovery.minBaseFeePct) {
    reasons.push(`baseFee ${baseFee}% < ${preset.discovery.minBaseFeePct}%`);
  }

  const minTvl = preset.minTvlUsd * DISCOVERY_THRESHOLD_FACTOR;
  if (pool.tvlUsd === undefined || pool.tvlUsd < minTvl) {
    reasons.push(`TVL ${pool.tvlUsd?.toFixed(0) ?? "?"} < ${minTvl}`);
  }

  const volTvl =
    pool.tvlUsd !== undefined && pool.tvlUsd > 0 && pool.volume24hUsd !== undefined
      ? pool.volume24hUsd / pool.tvlUsd
      : null;
  const minVolTvl = preset.volTvlBounds.min * DISCOVERY_THRESHOLD_FACTOR;
  if (volTvl === null || volTvl < minVolTvl) {
    reasons.push(`vol/TVL ${volTvl?.toFixed(2) ?? "?"} < ${minVolTvl}`);
  }
  // Obergrenze (Wash-Trading) prüft das Screening — hier nicht ausschließen,
  // damit auffällige Pools sichtbar im Scanner landen statt still zu verschwinden.

  return { eligible: reasons.length === 0, reasons };
}

/** Sortierschlüssel der Shortlist: Aktivität relativ zur Größe. */
export function shortlistRank(pool: PoolMetrics): number {
  if (pool.tvlUsd === undefined || pool.tvlUsd <= 0 || pool.volume24hUsd === undefined) return 0;
  return pool.volume24hUsd / pool.tvlUsd;
}
