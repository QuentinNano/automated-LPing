import {
  evaluateTrackHealth,
  overallHealth,
  type HealthCheck,
  type PoolMetrics,
  type TrackHealthInput,
  type GlobalConfig,
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
  /** Messpunkte einer ganzen Runde in einem Stapel. */
  recordPoints(pools: PoolMetrics[], now?: Date): Promise<number>;
  deactivateExpired(now?: Date): Promise<number>;
  computeDueOutcomes(now?: Date, limit?: number, global?: GlobalConfig): Promise<number>;
  stats(now?: Date): Promise<{
    trackedActive: number;
    trackedTotal: number;
    points: number;
    features: number;
    /** Verschiedene Pool×Preset-Kombinationen — die Einheit aus KONZEPT-ML 3.1. */
    distinctCandidates: number;
    /** Verschiedene Pools, unabhängig vom Preset. */
    distinctPools: number;
    outcomes: number;
    firstCaptureAt: Date | null;
    recordingDays: number;
  }>;
  /** Optional: Merkmalsschemata im Datensatz (nach Schema-Erweiterungen). */
  featureVersions?(): Promise<FeatureVersionRow[]>;
}

export interface TrackDeps {
  store: TrackStore;
  /**
   * Pool-Metriken für viele Adressen **auf einmal**.
   *
   * Das ist der Unterschied zwischen einer Aufzeichnung, die mitkommt, und einer,
   * die zurückfällt: Einzeln abgefragt kostet jeder Messpunkt eine Anfrage, und
   * bei einigen tausend verfolgten Pools reicht kein Zeitraster dafür aus. Die
   * Pool-Liste liefert bis zu 1.000 Pools pro Antwort.
   */
  getPools(poolAddresses: string[]): Promise<PoolMetrics[]>;
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * Pools je Durchgang.
 *
 * Früher lag die Grenze bei 300, weil jeder Messpunkt eine eigene Anfrage
 * kostete. Mit dem Sammelabruf sind 2.000 Pools rund 50 Anfragen — die Grenze
 * schützt jetzt nur noch vor einer Runde, die länger dauert als das Messraster.
 */
export const DEFAULT_CYCLE_LIMIT = 2000;

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
  options: { limit?: number; denseIntervalMin?: number; global?: GlobalConfig } = {},
): Promise<TrackCycleResult> {
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const notes: string[] = [];
  const denseIntervalMin = options.denseIntervalMin ?? 15;

  const expired = await deps.store.deactivateExpired(now);
  const due = await deps.store.duePools(now, options.limit ?? DEFAULT_CYCLE_LIMIT, denseIntervalMin);

  let recorded = 0;
  let failed = 0;

  if (due.length > 0) {
    const addresses = due.map((entry) => entry.poolAddress);
    try {
      const pools = await deps.getPools(addresses);
      recorded = await deps.store.recordPoints(pools, (deps.now ?? (() => new Date()))());

      // Fehlende Adressen sind normal (Pool entfernt, von Meteora auf die
      // Blacklist gesetzt), aber sie dürfen nicht unsichtbar bleiben: Genau so
      // sieht eine still verarmende Aufzeichnung aus.
      failed = due.length - recorded;
      if (failed > 0) {
        const found = new Set(pools.map((pool) => pool.poolAddress));
        const missing = addresses.filter((address) => !found.has(address));
        notes.push(
          `${failed} Pool(s) ohne Messpunkt` +
            (missing.length > 0 ? `, z. B. ${missing.slice(0, 3).join(", ")}` : ""),
        );
      }
    } catch (error) {
      // Anders als früher trifft ein Fehler jetzt die ganze Runde, nicht einen
      // Pool. Das ist der Preis des Sammelabrufs — und weil die Runde beim
      // nächsten Durchgang unverändert fällig ist, kostet er nur diesen.
      failed = due.length;
      notes.push(`Sammelabruf fehlgeschlagen: ${message(error)}`);
    }
  }

  // `global` trägt die Modellannahmen, mit denen die Simulations-Labels
  // gerechnet werden. Fehlt es, entstehen weiterhin die Kennzahl-Labels — eine
  // fehlende Konfiguration soll die Nachberechnung nicht anhalten, sondern nur
  // ärmer machen.
  const outcomes = await deps.store.computeDueOutcomes(now, undefined, options.global);

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
  targetCandidates = 3000,
): string {
  const lines: string[] = [];
  const days = stats.recordingDays;
  // Maßgeblich sind **verschiedene** Pool×Preset-Kombinationen, nicht Zeilen:
  // Derselbe Pool wird bei jedem Scan erneut erfasst. Die Zeilen sind nicht
  // wertlos (Merkmale und Horizonte unterscheiden sich), aber sie sind stark
  // korreliert — als unabhängige Beobachtungen zählen sie nicht.
  const distinct = stats.distinctCandidates;

  lines.push(
    `Aufzeichnung: ${distinct} verschiedene Kandidaten (Pool×Preset) ` +
      `aus ${stats.distinctPools} Pools, ${stats.points} Messpunkte, ` +
      `${stats.outcomes} Ergebnis-Labels`,
  );
  if (stats.features > distinct) {
    const perCandidate = stats.features / Math.max(1, distinct);
    lines.push(
      `  ${stats.features} Merkmalszeilen insgesamt — jeder Kandidat im Schnitt ` +
        `${perCandidate.toFixed(1)}× erfasst (Wiederholungen zählen nicht als` +
        ` eigene Beobachtung).`,
    );
  }
  lines.push(
    `Verfolgte Pools: ${stats.trackedActive} aktiv (${stats.trackedTotal} insgesamt)`,
  );

  if (stats.firstCaptureAt === null || days < 0.5) {
    lines.push("Läuft seit weniger als einem halben Tag — für eine Schätzung zu früh.");
    return lines.join("\n");
  }

  const perDay = distinct / days;
  lines.push(`Läuft seit ${days.toFixed(1)} Tagen (${perDay.toFixed(0)} neue Kandidaten/Tag)`);

  if (distinct >= targetCandidates) {
    lines.push(`✓ Zielmenge von ${targetCandidates} verschiedenen Kandidaten erreicht.`);
  } else {
    const remainingDays = perDay > 0 ? (targetCandidates - distinct) / perDay : Infinity;
    lines.push(
      Number.isFinite(remainingDays)
        ? `Noch ca. ${Math.ceil(remainingDays)} Tage bis ${targetCandidates} verschiedene Kandidaten.`
        : "Es kommen derzeit keine neuen Kandidaten dazu — läuft der Scan?",
    );
    // Ein Datensatz wächst nur durch neue Pools. Bleibt die Breite klein,
    // verlängert längeres Warten die Zeitreihen, nicht die Beobachtungszahl.
    if (perDay > 0 && perDay < 50) {
      lines.push(
        `⚠ Nur ${perDay.toFixed(0)} neue Kandidaten pro Tag — die Suche sieht zu wenige`,
        "  verschiedene Pools. Mehr Breite über TOP=… bei `pnpm aufzeichnen`",
        "  (Default 40) oder `track -- --top 40`.",
      );
    }
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
