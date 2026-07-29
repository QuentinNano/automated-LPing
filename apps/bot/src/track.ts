import {
  evaluateTrackHealth,
  overallHealth,
  type HealthCheck,
  type PoolMetrics,
  type TrackHealthInput,
} from "@lping/core";

/**
 * Aufzeichnungsdienst für die Strategie-Optimierung (KONZEPT-ML.md, M1).
 *
 * Läuft unabhängig vom Paper-Trading: Verfolgt werden **alle** entdeckten Pools,
 * nicht nur die, in die investiert wurde. Genau das entfernt die
 * Selektionsverzerrung und vervielfacht die Zahl der Beobachtungen.
 *
 * Der Dienst ist bewusst anspruchslos — er ruft nur Pool-Metriken ab und
 * schreibt sie fort. Die teuren Per-Token-Abrufe fallen einmalig beim Entdecken
 * an, nicht bei jedem Messpunkt.
 */

export interface TrackStore {
  duePools(
    now?: Date,
    limit?: number,
    denseIntervalMin?: number,
  ): Promise<{ poolAddress: string; tokenMint: string }[]>;
  /** Optional: Minuten bis zum nächsten fälligen Messpunkt. */
  nextDueInMinutes?(now?: Date, denseIntervalMin?: number): Promise<number | null>;
  recordPoint(pool: PoolMetrics, now?: Date): Promise<void>;
  deactivateExpired(now?: Date): Promise<number>;
  computeDueOutcomes(now?: Date, limit?: number): Promise<number>;
  stats(now?: Date): Promise<{
    trackedActive: number;
    trackedTotal: number;
    points: number;
    features: number;
    outcomes: number;
    firstCaptureAt: Date | null;
    recordingDays: number;
  }>;
  /** Optional: Merkmalsschemata im Datensatz (nach Schema-Erweiterungen). */
  featureVersions?(): Promise<FeatureVersionRow[]>;
}

export interface TrackDeps {
  store: TrackStore;
  getPool(poolAddress: string): Promise<PoolMetrics>;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface TrackCycleResult {
  due: number;
  recorded: number;
  failed: number;
  expired: number;
  outcomes: number;
  notes: string[];
}

export async function runTrackCycle(
  deps: TrackDeps,
  options: { limit?: number; denseIntervalMin?: number } = {},
): Promise<TrackCycleResult> {
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const notes: string[] = [];
  const denseIntervalMin = options.denseIntervalMin ?? 15;

  const expired = await deps.store.deactivateExpired(now);
  const due = await deps.store.duePools(now, options.limit ?? 300, denseIntervalMin);

  let recorded = 0;
  let failed = 0;
  let firstError: string | null = null;

  for (const entry of due) {
    try {
      const pool = await deps.getPool(entry.poolAddress);
      await deps.store.recordPoint(pool, (deps.now ?? (() => new Date()))());
      recorded++;
    } catch (error) {
      failed++;
      // Einzelne nicht erreichbare Pools sind normal (Pool entfernt, API-Aussetzer).
      // Nur der erste Fehler wird gemeldet, sonst ertrinkt die Ausgabe darin.
      if (firstError === null) firstError = message(error);
    }
  }
  if (firstError !== null) {
    notes.push(`${failed} Pool(s) nicht abrufbar, erster Fehler: ${firstError}`);
  }

  const outcomes = await deps.store.computeDueOutcomes(now);

  if (due.length === 0) {
    // Ohne Erklärung sieht "0/0" wie ein Stillstand aus, obwohl es der
    // Normalfall ist: Jeder Pool wird nur nach seinem eigenen Raster gemessen.
    const nextIn = deps.store.nextDueInMinutes
      ? await deps.store.nextDueInMinutes(now, denseIntervalMin)
      : null;
    log(
      nextIn === null
        ? "Kein Pool fällig (es wird noch keiner verfolgt)."
        : `Kein Pool fällig — nächster Messpunkt in ${Math.ceil(nextIn)} min ` +
          `(Raster: ${denseIntervalMin} min je Pool).`,
    );
  } else {
    log(
      `${recorded}/${due.length} Messpunkte geschrieben` +
        (failed > 0 ? `, ${failed} fehlgeschlagen` : "") +
        (expired > 0 ? `, ${expired} Verfolgungen beendet` : "") +
        (outcomes > 0 ? `, ${outcomes} Ergebnis-Labels berechnet` : ""),
    );
  }
  if (due.length === 0 && outcomes > 0) log(`${outcomes} Ergebnis-Labels berechnet.`);

  return { due: due.length, recorded, failed, expired, outcomes, notes };
}

/**
 * Fortschrittsbericht für die Wartezeit. Die Restdauer wird aus der
 * **tatsächlichen** Sammelrate geschätzt, nicht pauschal angesetzt — so ist
 * sichtbar, ob die Aufzeichnung überhaupt vorankommt.
 */
export function formatTrackStatus(
  stats: Awaited<ReturnType<TrackStore["stats"]>>,
  targetFeatures = 3000,
): string {
  const lines: string[] = [];
  const days = stats.recordingDays;

  lines.push(
    `Aufzeichnung: ${stats.features} Kandidaten-Merkmale, ${stats.points} Messpunkte, ` +
      `${stats.outcomes} Ergebnis-Labels`,
  );
  lines.push(
    `Verfolgte Pools: ${stats.trackedActive} aktiv (${stats.trackedTotal} insgesamt)`,
  );

  if (stats.firstCaptureAt === null || days < 0.5) {
    lines.push("Läuft seit weniger als einem halben Tag — für eine Schätzung zu früh.");
    return lines.join("\n");
  }

  lines.push(`Läuft seit ${days.toFixed(1)} Tagen (${(stats.features / days).toFixed(0)}/Tag)`);

  if (stats.features >= targetFeatures) {
    lines.push(`✓ Zielmenge von ${targetFeatures} Merkmalen erreicht.`);
  } else {
    const perDay = stats.features / days;
    const remainingDays = perDay > 0 ? (targetFeatures - stats.features) / perDay : Infinity;
    lines.push(
      Number.isFinite(remainingDays)
        ? `Noch ca. ${Math.ceil(remainingDays)} Tage bis ${targetFeatures} Merkmale.`
        : "Es kommen derzeit keine neuen Merkmale dazu — läuft der Scan?",
    );
  }

  // Lücken sind das größte Qualitätsrisiko: ein schlafender Rechner erzeugt
  // systematisch fehlende Nachtstunden, was den Datensatz verzerrt.
  const expectedPoints = stats.trackedTotal * days * 24;
  if (expectedPoints > 0 && stats.points < expectedPoints * 0.4) {
    lines.push(
      "⚠ Deutlich weniger Messpunkte als erwartet — vermutlich lief die Aufzeichnung",
      "  zeitweise nicht (Rechner im Ruhezustand?). Lücken verzerren den Datensatz.",
    );
  }

  return lines.join("\n");
}

export interface FeatureVersionRow {
  featureVersion: number;
  count: number;
  firstAt: Date;
  lastAt: Date;
}

/**
 * Weist aus, ob der Datensatz mehrere Merkmalsschemata enthält.
 *
 * Nach einer Schema-Erweiterung ist das der Normalfall und unproblematisch —
 * aber nur, solange man es weiß: Zeilen verschiedener Versionen haben
 * unterschiedliche Spalten und dürfen nicht gemeinsam trainiert werden.
 */
export function formatFeatureVersions(rows: FeatureVersionRow[]): string {
  if (rows.length === 0) return "Merkmalsschema: noch keine Aufzeichnungen.";
  if (rows.length === 1) {
    const only = rows[0]!;
    return `Merkmalsschema: v${only.featureVersion} (${only.count} Kandidaten).`;
  }

  const lines = ["Merkmalsschema: mehrere Versionen im Datensatz —"];
  for (const row of rows) {
    lines.push(
      `  v${row.featureVersion}: ${row.count} Kandidaten ` +
        `(${row.firstAt.toISOString().slice(0, 10)} bis ${row.lastAt.toISOString().slice(0, 10)})`,
    );
  }
  const newest = rows[rows.length - 1]!;
  lines.push(
    `  Für die Optimierung eine Version wählen (jüngste: v${newest.featureVersion}).`,
    "  Ältere Zeilen haben weniger Spalten; gemeinsam trainiert sähe das nach",
    "  fehlenden Werten aus statt nach zwei Schemata.",
  );
  return lines.join("\n");
}

/**
 * Prüfbericht: beantwortet „läuft die Aufzeichnung wie erwartet?" mit einem
 * Urteil je Aspekt statt mit Zahlen, die man selbst deuten müsste.
 */
export function formatHealthReport(metrics: TrackHealthInput): string {
  const checks = evaluateTrackHealth(metrics);
  const overall = overallHealth(checks);
  const lines: string[] = [];

  const width = Math.max(...checks.map((c) => c.label.length), 20);
  for (const check of checks) {
    lines.push(`  ${symbol(check)} ${check.label.padEnd(width)}  ${check.detail}`);
    if (check.hint !== undefined) lines.push(`      → ${check.hint}`);
  }

  lines.push("");
  switch (overall) {
    case "ok":
      lines.push("Die Aufzeichnung läuft wie erwartet.");
      break;
    case "warn":
      lines.push(
        "Die Aufzeichnung läuft, aber mit Einschränkungen (siehe ! oben).",
        "Sie ist nutzbar — behebe die Punkte, wenn sie bestehen bleiben.",
      );
      break;
    case "fail":
      lines.push(
        "Die Aufzeichnung arbeitet NICHT wie erwartet (siehe ✗ oben).",
        "In diesem Zustand entstehen unbrauchbare oder verzerrte Daten.",
      );
      break;
    default:
      break;
  }
  return lines.join("\n");
}

function symbol(check: HealthCheck): string {
  switch (check.status) {
    case "ok":
      return "✓";
    case "warn":
      return "!";
    case "fail":
      return "✗";
    default:
      return "·";
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
