/**
 * Beurteilung der Aufzeichnung (KONZEPT-ML.md M1).
 *
 * Reine Auswertung ohne Datenbankzugriff: Die Kennzahlen werden außen erhoben,
 * hier nur bewertet. Zweck ist eine Antwort auf die Frage „läuft es wie
 * erwartet?" statt einer Zahlenkolonne, die man selbst deuten muss.
 *
 * Der Maßstab ist bewusst streng: Eine Aufzeichnung, die halb funktioniert,
 * erzeugt einen verzerrten Datensatz — und der ist schlimmer als gar keiner,
 * weil man ihm den Fehler nicht ansieht.
 */

export type HealthStatus = "ok" | "warn" | "fail" | "info";

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  detail: string;
  /** Was zu tun ist, wenn der Check nicht ok ist. */
  hint?: string;
}

export interface TrackHealthInput {
  now: Date;
  /** Aktuell verfolgte Pools. */
  trackedActive: number;
  /** Zeitpunkt des jüngsten Messpunkts. */
  newestPointAt: Date | null;
  /** Messpunkte der letzten Stunde. */
  pointsLastHour: number;
  /** Verschiedene Pools mit mindestens einem Punkt in der letzten Stunde. */
  poolsWithPointLastHour: number;
  /** Neue Merkmalsvektoren der letzten 6 Stunden. */
  featuresLast6h: number;
  featuresTotal: number;
  outcomesTotal: number;
  oldestFeatureAt: Date | null;
  /**
   * Belegungsgrad wichtiger Merkmale (0–1) in einer Stichprobe der jüngsten
   * Aufzeichnungen. Zeigt, ob eine Datenquelle stillschweigend ausfällt.
   */
  fieldCoverage: Record<string, number>;
  /** Größte Lücke zwischen zwei Messpunkten der letzten 24 h, in Minuten. */
  largestGapMinutes: number | null;
  /** Erwarteter Abstand zwischen Messpunkten in Minuten. */
  expectedIntervalMin: number;
}

/** Merkmale, deren Ausbleiben auf eine defekte Datenquelle hindeutet. */
const WATCHED_FIELDS: { key: string; label: string; source: string; minShare: number }[] = [
  { key: "tvl_usd", label: "Pool-Kennzahlen", source: "Meteora", minShare: 0.9 },
  { key: "token_age_hours", label: "Marktdaten", source: "DexScreener", minShare: 0.6 },
  { key: "risk_score", label: "Risiko-Report", source: "RugCheck", minShare: 0.5 },
  { key: "roundtrip_loss_pct", label: "Verkaufbarkeit", source: "Jupiter", minShare: 0.5 },
  { key: "organic_score", label: "Organic Score", source: "Jupiter Token API", minShare: 0.3 },
];

export function evaluateTrackHealth(input: TrackHealthInput): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const nowMs = input.now.getTime();

  // --- 1. Läuft die Aufzeichnung überhaupt? --------------------------------
  if (input.newestPointAt === null) {
    checks.push({
      id: "running",
      label: "Aufzeichnung aktiv",
      status: "fail",
      detail: "Es wurde noch kein einziger Messpunkt geschrieben.",
      hint: "Läuft `pnpm aufzeichnen`? Prüfe die Ausgabe des laufenden Fensters.",
    });
  } else {
    const ageMin = (nowMs - input.newestPointAt.getTime()) / 60_000;
    const stale = ageMin > input.expectedIntervalMin * 2.5;
    checks.push({
      id: "running",
      label: "Aufzeichnung aktiv",
      status: stale ? "fail" : "ok",
      detail: `Jüngster Messpunkt vor ${formatMinutes(ageMin)}.`,
      ...(stale
        ? {
            hint: `Erwartet wären höchstens ${input.expectedIntervalMin} Minuten. Läuft \`pnpm aufzeichnen\` noch?`,
          }
        : {}),
    });
  }

  // --- 2. Werden überhaupt Pools verfolgt? ---------------------------------
  checks.push(
    input.trackedActive === 0
      ? {
          id: "tracked",
          label: "Verfolgte Pools",
          status: "fail",
          detail: "Kein Pool wird verfolgt.",
          hint: "Die Suche findet nichts. Prüfe: pnpm --filter @lping/bot api:check",
        }
      : {
          id: "tracked",
          label: "Verfolgte Pools",
          status: "ok",
          detail: `${input.trackedActive} Pools werden verfolgt.`,
        },
  );

  // --- 3. Kommen neue Kandidaten dazu? -------------------------------------
  // Ohne neue Funde schrumpft der Datensatz, sobald die Verfolgungsfristen
  // ablaufen — auch wenn die Messpunkte weiterlaufen.
  checks.push(
    input.featuresLast6h === 0
      ? {
          id: "discovery",
          label: "Neue Kandidaten",
          status: input.featuresTotal === 0 ? "fail" : "warn",
          detail: "In den letzten 6 Stunden kam kein neuer Kandidat dazu.",
          hint: "Die Suche liefert nichts. Prüfe: pnpm --filter @lping/bot scan -- --no-db",
        }
      : {
          id: "discovery",
          label: "Neue Kandidaten",
          status: "ok",
          detail: `${input.featuresLast6h} neue Merkmalsvektoren in 6 Stunden.`,
        },
  );

  // --- 4. Deckt die Aufzeichnung alle verfolgten Pools ab? -----------------
  if (input.trackedActive > 0) {
    const coverage = input.poolsWithPointLastHour / input.trackedActive;
    const status: HealthStatus = coverage >= 0.8 ? "ok" : coverage >= 0.4 ? "warn" : "fail";
    checks.push({
      id: "coverage",
      label: "Abdeckung",
      status,
      detail:
        `${input.poolsWithPointLastHour} von ${input.trackedActive} Pools ` +
        `in der letzten Stunde erfasst (${(coverage * 100).toFixed(0)} %).`,
      ...(status === "ok"
        ? {}
        : {
            hint: "Viele Pools werden übersprungen — häufig sind einzelne Pools nicht mehr abrufbar. Ein Blick ins Protokoll logs/track.log hilft.",
          }),
    });
  }

  // --- 5. Lücken ------------------------------------------------------------
  if (input.largestGapMinutes !== null) {
    const gap = input.largestGapMinutes;
    const status: HealthStatus =
      gap <= input.expectedIntervalMin * 3 ? "ok" : gap <= 180 ? "warn" : "fail";
    checks.push({
      id: "gaps",
      label: "Lückenlosigkeit",
      status,
      detail: `Größte Unterbrechung der letzten 24 Stunden: ${formatMinutes(gap)}.`,
      ...(status === "ok"
        ? {}
        : {
            hint: "Längere Unterbrechungen verzerren den Datensatz systematisch (meist fehlen Nachtstunden). Rechner durchlaufen lassen oder auf einen Server umziehen.",
          }),
    });
  }

  // --- 6. Liefern alle Datenquellen? ---------------------------------------
  for (const field of WATCHED_FIELDS) {
    const share = input.fieldCoverage[field.key];
    if (share === undefined) continue;
    const status: HealthStatus = share >= field.minShare ? "ok" : share > 0 ? "warn" : "fail";
    checks.push({
      id: `field_${field.key}`,
      label: `Datenquelle ${field.source}`,
      status,
      detail: `${field.label} bei ${(share * 100).toFixed(0)} % der Kandidaten vorhanden.`,
      ...(status === "ok"
        ? {}
        : {
            hint:
              share === 0
                ? `${field.source} liefert gar nichts — vermutlich ein API-Fehler oder eine Formatänderung.`
                : `${field.source} liefert nur teilweise. Bei anhaltend niedrigem Wert melden.`,
          }),
    });
  }

  // --- 7. Werden Ergebnis-Labels berechnet? --------------------------------
  // Erst sinnvoll, wenn der erste Kandidat den kürzesten Horizont überschritten hat.
  if (input.oldestFeatureAt !== null) {
    const oldestAgeHours = (nowMs - input.oldestFeatureAt.getTime()) / 3_600_000;
    if (oldestAgeHours < 1.5) {
      checks.push({
        id: "outcomes",
        label: "Ergebnis-Labels",
        status: "info",
        detail: "Noch zu früh — das erste Label entsteht eine Stunde nach dem ersten Kandidaten.",
      });
    } else {
      checks.push(
        input.outcomesTotal === 0
          ? {
              id: "outcomes",
              label: "Ergebnis-Labels",
              status: "fail",
              detail: `Seit ${oldestAgeHours.toFixed(0)} Stunden Daten, aber kein einziges Label berechnet.`,
              hint: "Ohne Labels ist der Datensatz für die Optimierung wertlos. Bitte melden.",
            }
          : {
              id: "outcomes",
              label: "Ergebnis-Labels",
              status: "ok",
              detail: `${input.outcomesTotal} Labels berechnet.`,
            },
      );
    }
  }

  return checks;
}

/** Gesamturteil: der schlechteste Einzelbefund entscheidet. */
export function overallHealth(checks: HealthCheck[]): HealthStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "ok";
}

function formatMinutes(minutes: number): string {
  if (minutes < 1) return "unter einer Minute";
  if (minutes < 90) return `${Math.round(minutes)} Minuten`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} Stunden`;
  return `${(hours / 24).toFixed(1)} Tage`;
}
