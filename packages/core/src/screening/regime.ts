import type { RegimeConfig } from "../config/schema";
import { feeYieldPerVariance } from "../ml/volatility";

/**
 * Marktregime: die Frage **vor** der Pool-Auswahl.
 *
 * **Warum es diese Datei gibt.** Screening und Score beantworten „welcher Pool
 * ist der beste?". Sie beantworten nicht „ist heute überhaupt einer gut
 * genug?". Der Unterschied ist folgenreich, weil beide Fragen verschiedene
 * Antworten haben können: Aus einem Feld schlechter Kandidaten wählt der Score
 * zuverlässig den besten schlechten aus und eröffnet ihn.
 *
 * Die Bedingung, unter der LPing überhaupt trägt, ist nicht „viel Gebühr",
 * sondern **„mehr Gebühr als Varianzverlust"**. Der Verlust einer Position
 * gegenüber schlichtem Halten wächst näherungsweise mit σ²/8 je Zeiteinheit,
 * der Ertrag linear mit der Gebührenrate. `feeYieldPerVariance` misst das je
 * Pool. Über die heutigen Kandidaten aggregiert misst es das **Regime**.
 *
 * Das ist der billigste verfügbare Hebel: Ein Tor, das in ungünstigen Regimen
 * gar nicht erst eröffnet, wirkt auf **alle** Presets gleichzeitig und kostet
 * keine Kalenderzeit — anders als jede Parametersuche, die erst einen
 * Datensatz braucht und dann nur ein Preset verbessert.
 *
 * **Was es ausdrücklich nicht ist:** eine Prognose. Gemessen wird der Zustand
 * der Gegenwart, nicht die Richtung der Zukunft. Ein günstiges Regime sagt,
 * dass die heutigen Kandidaten ihren Varianzverlust decken — nicht, dass sie
 * es morgen noch tun.
 */

/** Eine Pool-Beobachtung, wie sie das Screening ohnehin erzeugt. */
export interface RegimeObservation {
  poolAddress: string;
  /** Gebührenertragsrate des Pools: Gebühren je TVL und Tag, in Prozent. */
  feeRatePctPerDay: number | null;
  /** Geschätzte realisierte Tagesvolatilität des Tokens in Prozent. */
  volatilityPctDaily: number | null;
}

export type RegimeStatus = "favourable" | "neutral" | "adverse" | "unknown";

export interface RegimeVerdict {
  status: RegimeStatus;
  /**
   * Median des Verhältnisses Gebührenertrag zu Varianzverlust über die
   * bewertbaren Pools.
   *
   * Median statt Mittelwert: Ein einzelner Pool mit absurdem Verhältnis — meist
   * ein Messfehler oder ein Wash-Trading-Verdacht — soll das Urteil über den
   * Markt nicht drehen.
   */
  medianYieldPerVariance: number | null;
  /** Wie viele Pools die Aussage tragen. */
  sampled: number;
  /** Wie viele Beobachtungen mangels Volatilität oder Gebührenrate ausfielen. */
  skipped: number;
  /** Ausformuliertes Urteil — die Zahl allein sagt nicht, was daraus folgt. */
  reason: string;
}

/**
 * Beurteilt das Regime aus den Beobachtungen eines Scan-Durchgangs.
 *
 * Doppelte Pools zählen einmal: Ein Pool, der für drei Presets in Frage kommt,
 * ist ein Marktdatenpunkt und nicht drei — sonst gewichtet die Aggregation
 * still nach der Zahl der Presets, für die ein Pool gerade passt.
 */
export function assessRegime(
  observations: RegimeObservation[],
  config: RegimeConfig,
): RegimeVerdict {
  const byPool = new Map<string, RegimeObservation>();
  for (const observation of observations) {
    if (!byPool.has(observation.poolAddress)) byPool.set(observation.poolAddress, observation);
  }

  const ratios: number[] = [];
  let skipped = 0;
  for (const observation of byPool.values()) {
    const rate = observation.feeRatePctPerDay;
    if (rate === null || !Number.isFinite(rate) || rate < 0) {
      skipped++;
      continue;
    }
    const ratio = feeYieldPerVariance(rate, observation.volatilityPctDaily);
    if (ratio === null || !Number.isFinite(ratio)) {
      skipped++;
      continue;
    }
    ratios.push(ratio);
  }

  const sampled = ratios.length;
  // Zu wenige Pools heißt "unbekannt", nicht "ungünstig". Ein Tor, das bei
  // dünner Datenlage zumacht, würde vor allem den ersten Betriebstag blockieren
  // und wäre nicht vom echten Befund zu unterscheiden.
  if (sampled < config.minPools) {
    return {
      status: "unknown",
      medianYieldPerVariance: median(ratios),
      sampled,
      skipped,
      reason:
        `nur ${sampled} von ${byPool.size} Pools bewertbar (nötig: ${config.minPools}) — ` +
        `zu dünn für ein Urteil über den Markt`,
    };
  }

  const value = median(ratios)!;
  const status: RegimeStatus =
    value < config.adverseBelow
      ? "adverse"
      : value >= config.favourableAbove
        ? "favourable"
        : "neutral";

  return {
    status,
    medianYieldPerVariance: value,
    sampled,
    skipped,
    reason: reasonFor(status, value, sampled, config),
  };
}

function reasonFor(
  status: RegimeStatus,
  value: number,
  sampled: number,
  config: RegimeConfig,
): string {
  const gemessen = `Median-Verhältnis Gebühr/Varianz ${value.toFixed(1)}× über ${sampled} Pools`;
  switch (status) {
    case "adverse":
      return (
        `${gemessen} — unter ${config.adverseBelow}×. Die Gebühren der heutigen ` +
        `Kandidaten decken ihren erwarteten Varianzverlust nicht; eine Position ` +
        `verliert dann gegen schlichtes Halten, unabhängig davon, welcher Pool es wird`
      );
    case "favourable":
      return (
        `${gemessen} — ab ${config.favourableAbove}×. Der Gebührenertrag trägt den ` +
        `Varianzverlust mit Abstand, der auch Kosten und Zeit außerhalb der Range deckt`
      );
    default:
      return (
        `${gemessen} — zwischen ${config.adverseBelow}× und ${config.favourableAbove}×. ` +
        `Tragfähig, aber ohne Puffer für Kosten und Modellfehler`
      );
  }
}

/**
 * Blockiert dieses Regime das Eröffnen neuer Positionen?
 *
 * `unknown` blockiert bewusst **nicht**: Fehlende Messung ist kein Befund, und
 * ein Tor, das ohne Daten schließt, verhindert genau die Aufzeichnung, aus der
 * die Daten entstünden.
 */
export function regimeBlocksOpening(verdict: RegimeVerdict, config: RegimeConfig): boolean {
  return config.enabled && config.blockOpening && verdict.status === "adverse";
}

function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}
