import { runHardFilters } from "./filters";
import { computeScore } from "./score";
import type { ScreeningInput, ScreeningResult } from "./types";

/**
 * Vollständiges Screening eines Kandidaten: Hard Filters + Score + Verdict
 * (KONZEPT.md Abschnitt 5). Abgelehnt wird bei mindestens einem
 * fehlgeschlagenen Hard Filter ODER Score unter dem Preset-Mindestscore.
 * Der Score wird auch für Abgelehnte berechnet (Scanner-Transparenz,
 * Shadow-Tracking-Auswertung).
 */
export function screenCandidate(input: ScreeningInput): ScreeningResult {
  const checks = runHardFilters(input);
  const score = computeScore(input);

  const rejectedBy = checks.filter((c) => c.status === "failed").map((c) => c.id);
  if (score.total < input.preset.minScore) {
    rejectedBy.push("min_score");
  }

  return {
    verdict: rejectedBy.length === 0 ? "accepted" : "rejected",
    checks,
    rejectedBy,
    score,
    screenedAt: new Date(),
  };
}
