import {
  replayEntries,
  summarizeReplay,
  type BotConfig,
  type PresetKind,
  type ReplayPool,
  type ReplayPosition,
  type ReplaySummary,
  type TrackPoint,
} from "@lping/core";

/**
 * Replay-Lauf über die aufgezeichneten Verläufe (KONZEPT-ML.md M2).
 *
 * Was das gegenüber dem Paper-Vergleich hinzugewinnt: Der Paper-Betrieb eröffnet
 * eine Position, wenn ein Kandidat gerade akzeptiert wird — ein paar hundert in
 * Wochen. Der Replay eröffnet an **beliebigen** Zeitpunkten jedes
 * aufgezeichneten Verlaufs, für alle Presets auf denselben Daten. Aus
 * Kalenderzeit wird Rechenzeit.
 *
 * Was er **nicht** hinzugewinnt: Realismus. Er sieht dieselben Modellfehler wie
 * die Paper-Engine, weil er dieselbe Engine ist (KONZEPT-ML.md 10.1).
 */

export interface ReplayStore {
  replayPools(poolAddresses?: string[]): Promise<ReplayPool[]>;
  loadSeries(poolAddress: string, since: Date, until: Date): Promise<TrackPoint[]>;
}

export interface ReplayDeps {
  store: ReplayStore;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface ReplayRunOptions {
  /** Nur diese Pools abspielen; sonst alle mit Stammdaten. */
  pools?: string[];
  /** Wie weit zurück der Verlauf gelesen wird. */
  days?: number;
  /** Abstand zwischen zwei Einstiegen in Minuten. */
  everyMinutes?: number;
  /** Obergrenze je Pool und Preset. */
  maxPositionsPerPool?: number;
}

export interface ReplayRunResult {
  /** Pools, aus denen mindestens eine Position entstand. */
  pools: number;
  /** Pools ohne verwertbaren Verlauf im Zeitraum. */
  skipped: number;
  points: number;
  byPreset: { preset: PresetKind; label: string; summary: ReplaySummary }[];
  notes: string[];
}

const DEFAULT_DAYS = 7;

export async function runReplay(
  deps: ReplayDeps,
  config: BotConfig,
  options: ReplayRunOptions = {},
): Promise<ReplayRunResult> {
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - (options.days ?? DEFAULT_DAYS) * 86_400_000);

  const pools = await deps.store.replayPools(options.pools);
  const notes: string[] = [];
  if (pools.length === 0) {
    notes.push(
      "Keine Pool-Stammdaten gefunden. Der Replay braucht gescreente Kandidaten — " +
        "läuft die Aufzeichnung (`pnpm aufzeichnen`)?",
    );
    return { pools: 0, skipped: 0, points: 0, byPreset: [], notes };
  }

  const presets = Object.entries(config.presets).filter(([, preset]) => preset.enabled);
  const positions = new Map<PresetKind, ReplayPosition[]>();
  for (const [id] of presets) positions.set(id, []);

  let used = 0;
  let skipped = 0;
  let points = 0;

  for (const pool of pools) {
    const series = await deps.store.loadSeries(pool.poolAddress, since, now);
    // Ein einzelner Punkt ergibt keine Position: Ohne zweiten Zeitpunkt gibt es
    // keine Preisbewegung und keine verstrichene Zeit.
    if (series.length < 2) {
      skipped++;
      continue;
    }
    points += series.length;
    used++;

    // Alle Presets auf **demselben** Verlauf — Unterschiede stammen damit
    // ausschließlich aus den Parametern (KONZEPT.md 6).
    for (const [id, preset] of presets) {
      const found = replayEntries(series, pool, {
        preset,
        global: config.global,
        ...(options.everyMinutes !== undefined ? { everyMinutes: options.everyMinutes } : {}),
        ...(options.maxPositionsPerPool !== undefined
          ? { maxPositions: options.maxPositionsPerPool }
          : {}),
      });
      positions.get(id)!.push(...found);
    }
  }

  if (skipped > 0) {
    notes.push(
      `${skipped} Pool(s) ohne verwertbaren Verlauf im Zeitraum — ` +
        "`pnpm nachladen` holt fehlende Historie.",
    );
  }
  log(`${used} Pools, ${points} Beobachtungen abgespielt`);

  return {
    pools: used,
    skipped,
    points,
    byPreset: presets.map(([id, preset]) => ({
      preset: id,
      label: preset.label,
      summary: summarizeReplay(positions.get(id)!),
    })),
    notes,
  };
}

/** Vergleichstabelle des Replay-Laufs. */
export function formatReplayResult(result: ReplayRunResult): string {
  if (result.byPreset.length === 0) {
    return result.notes.join("\n") || "Kein Ergebnis.";
  }

  const header = [
    pad("Preset", 14),
    pad("Pos.", 6),
    pad("davon zu", 9),
    pad("PnL SOL", 10),
    pad("Median%", 9),
    pad("Fees", 9),
    pad("Kosten", 9),
    pad("Win%", 6),
    pad("inRange%", 9),
    "vs HODL",
  ].join(" ");
  const lines = [header, "-".repeat(header.length + 4)];

  for (const row of [...result.byPreset].sort(
    (a, b) => b.summary.totalPnlSol - a.summary.totalPnlSol,
  )) {
    const s = row.summary;
    lines.push(
      [
        pad(row.label, 14),
        pad(String(s.positions), 6),
        pad(String(s.decided), 9),
        pad(signed(s.totalPnlSol, 4), 10),
        pad(s.medianPnlPct === null ? "–" : signed(s.medianPnlPct, 2), 9),
        pad(s.feesSol.toFixed(4), 9),
        pad(s.costsSol.toFixed(4), 9),
        pad(s.winRatePct === null ? "–" : s.winRatePct.toFixed(0), 6),
        pad(s.avgTimeInRangePct === null ? "–" : s.avgTimeInRangePct.toFixed(0), 9),
        signed(s.vsHodlSol, 4),
      ].join(" "),
    );
  }

  lines.push("", `Grundlage: ${result.pools} Pools, ${result.points} Beobachtungen.`);

  // Ausstiegsgründe zeigen, wodurch die Positionen endeten — ohne sie ist eine
  // Zahl nicht zu deuten. Ein Preset, das nur ins Zeitlimit läuft, wird anders
  // gelesen als eines, das reihenweise Stop-Loss auslöst.
  for (const row of result.byPreset) {
    const reasons = Object.entries(row.summary.closeReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `${reason} ${count}`)
      .join(", ");
    lines.push(`  ${pad(row.label, 14)} ${reasons || "keine abgeschlossene Position"}`);
  }

  const censored = result.byPreset.reduce((total, row) => total + row.summary.censored, 0);
  if (censored > 0) {
    lines.push(
      "",
      `Hinweis: ${censored} Position(en) waren am Ende des Verlaufs noch offen.`,
      "Sie zählen in PnL und Kosten mit, aber nicht in Trefferquote und",
      "Ausstiegsgründen — ob sie gewonnen hätten, ist unbekannt.",
    );
  }

  const decided = result.byPreset.reduce((total, row) => total + row.summary.decided, 0);
  if (decided < 30) {
    lines.push(
      "",
      `Erst ${decided} abgeschlossene Positionen — zu wenig für eine Aussage.`,
      "Mehr Verlauf (`pnpm nachladen`) oder engere Einstiege (`--every`) helfen;",
      "beachte aber, dass sich überlappende Einstiege nicht unabhängig sind.",
    );
  }

  return lines.join("\n");
}

function pad(value: string, width: number): string {
  return value.length > width ? value.slice(0, width - 1) + "…" : value.padEnd(width);
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}
