import type { BotConfig } from "../config/schema";
import { minTvlAcrossPresets } from "./replicate";

/**
 * Abfragestrategien für die Pool-Discovery (KONZEPT.md 4.1).
 *
 * Hintergrund: Die Meteora-Pool-API sortiert standardmäßig nach
 * 24-Stunden-Volumen. Wer nur die ersten Seiten dieser Sortierung liest, sieht
 * ausschließlich etablierte Pools — ein Pool, der vor drei Stunden entstanden
 * ist, kann per Definition kein hohes 24-Stunden-Volumen haben. Genau solche
 * Pools sind aber das Degen-Fenster (1–48 h).
 *
 * Deshalb wird nicht "mehr Seiten einer Sortierung" gelesen, sondern es werden
 * mehrere Sortierungen zusammengeführt. Jede beantwortet eine andere Frage;
 * die Vereinigung ist die Grundgesamtheit, auf der das Screening arbeitet.
 */
export interface DiscoveryStrategy {
  /** Kurzname für Protokoll und Diagnose. */
  id: string;
  /** `sort_by`-Ausdruck der Schnittstelle. */
  sortBy: string;
  /** Warum diese Sortierung gebraucht wird. */
  rationale: string;
}

export const DISCOVERY_STRATEGIES: readonly DiscoveryStrategy[] = [
  {
    id: "volume",
    sortBy: "volume_24h:desc",
    rationale: "etablierte Aktivität — trägt die längerfristigen Presets",
  },
  {
    id: "fee_rate",
    sortBy: "fee_tvl_ratio_1h:desc",
    rationale: "aktuelle Ertragskraft — findet Pools, die gerade anfangen zu verdienen",
  },
  {
    id: "fresh",
    sortBy: "pool_created_at:desc",
    rationale: "neue Pools — das Degen-Altersfenster ist über Volumen nicht erreichbar",
  },
] as const;

/**
 * Serverseitiger `filter_by`-Ausdruck.
 *
 * Bewusst nur die zwei Bedingungen, die für **jedes** Preset gelten: Der Filter
 * ist Vorauswahl, nicht Entscheidung — abgelehnt wird im Screening, und zwar
 * nachvollziehbar mit Begründung. Ein zu scharfer Serverfilter würde Kandidaten
 * unsichtbar verschwinden lassen, statt sie im Scanner mit Grund auszuweisen.
 *
 * Nicht enthalten, obwohl die Schnittstelle es erlaubt:
 * - **Quote-Token.** `filter_by` verknüpft Ausdrücke mit UND, und SOL kann
 *   Token X *oder* Token Y sein. Ein `token_y=<SOL>` würde die SOL/X-Pools
 *   stillschweigend ausschließen; die Seitenprüfung bleibt daher clientseitig.
 * - **bin_step / Basisgebühr.** Sind laut Spezifikation nicht filterbar
 *   (`filter_by` kennt nur `tvl`, `volume_*`, `fee_*`, `fee_tvl_ratio_*`,
 *   `apr_*`, `is_blacklisted` und Textfelder).
 */
export function buildDiscoveryFilter(config: BotConfig): string {
  const clauses = ["is_blacklisted=false"];
  const minTvl = minTvlAcrossPresets(config.presets);
  if (minTvl > 0) clauses.push(`tvl>=${Math.floor(minTvl)}`);
  return clauses.join(" && ");
}
