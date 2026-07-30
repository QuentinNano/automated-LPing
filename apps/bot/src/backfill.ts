import {
  HISTORY_TIMEFRAMES,
  TIMEFRAME_MINUTES,
  type HistoryTimeframe,
  type PoolCandle,
} from "@lping/core";

/**
 * Nachladen der Pool-Historie (KONZEPT-ML.md 3.3).
 *
 * Die Aufzeichnung sammelt Momentaufnahmen im Messraster. Die Pool-API führt
 * darüber hinaus eine **Historie** — Preis, Volumen und Gebühren je Zeitfenster,
 * rückwirkend abrufbar bis auf 5-Minuten-Kerzen. Das ändert zwei Dinge:
 *
 * 1. **Unterbrechungen sind reparierbar.** Ein schlafender Rechner kostet keine
 *    Preis- und Volumenhistorie mehr, nur noch TVL-Messpunkte und Merkmale.
 * 2. **Neue Pools kommen mit Vorgeschichte.** Ein Pool, der seit 20 Stunden
 *    existiert und gerade entdeckt wurde, liefert sofort 20 Stunden Verlauf —
 *    Material für den Replay, das früher unerreichbar war.
 *
 * Was das Nachladen **nicht** liefert: TVL, dynamische Gebühr, SOL-Kurs. Die
 * gibt es nur als Momentaufnahme, also weiterhin ausschließlich aus der
 * laufenden Aufzeichnung. Deshalb ersetzt dieser Dienst sie nicht, er ergänzt
 * sie.
 */

export interface BackfillStore {
  trackedPools(options?: {
    activeOnly?: boolean;
    limit?: number;
  }): Promise<{ poolAddress: string; firstSeenAt: Date }[]>;
  newestCandleAt(
    poolAddresses: string[],
    timeframe: HistoryTimeframe,
  ): Promise<Map<string, Date>>;
  recordCandles(candles: PoolCandle[]): Promise<number>;
}

export interface BackfillDeps {
  store: BackfillStore;
  getHistory(
    poolAddress: string,
    query: { timeframe: HistoryTimeframe; startTime: Date; endTime: Date },
  ): Promise<PoolCandle[]>;
  log?: (line: string) => void;
  now?: () => Date;
}

export interface BackfillOptions {
  timeframe?: HistoryTimeframe;
  /**
   * Wie weit vor der ersten Sichtung eines Pools nachgeladen wird.
   *
   * Default sind sieben Tage — dieselbe Spanne, die die Verfolgung abdeckt und
   * die der längste Ergebnis-Horizont braucht. Weiter zurück wäre für die
   * Labels wertlos und für den Replay unbegrenzt.
   */
  lookbackHours?: number;
  /** Höchstens so viele Pools je Lauf (Default: alle). */
  limit?: number;
  /**
   * Länge eines einzelnen Abrufs in Stunden.
   *
   * Die Antwortgröße der Historien-Endpunkte ist nicht dokumentiert. 24 Stunden
   * sind bei 5-Minuten-Kerzen 288 Zeilen — klein genug, um nicht an eine
   * unbekannte Obergrenze zu stoßen, groß genug, um die Anfragen niedrig zu
   * halten.
   */
  chunkHours?: number;
  /** Nur aktive Verfolgungen berücksichtigen. */
  activeOnly?: boolean;
}

export interface BackfillResult {
  /** Pools, für die etwas nachgeladen wurde. */
  pools: number;
  /** Pools, die schon vollständig waren. */
  upToDate: number;
  candles: number;
  failed: number;
  notes: string[];
}

const DEFAULT_TIMEFRAME: HistoryTimeframe = "5m";
const DEFAULT_LOOKBACK_HOURS = 7 * 24;
const DEFAULT_CHUNK_HOURS = 24;

export async function runBackfill(
  deps: BackfillDeps,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const timeframe = options.timeframe ?? DEFAULT_TIMEFRAME;
  const lookbackMs = (options.lookbackHours ?? DEFAULT_LOOKBACK_HOURS) * 3_600_000;
  const chunkMs = (options.chunkHours ?? DEFAULT_CHUNK_HOURS) * 3_600_000;
  const stepMs = TIMEFRAME_MINUTES[timeframe] * 60_000;

  const tracked = await deps.store.trackedPools({
    ...(options.activeOnly !== undefined ? { activeOnly: options.activeOnly } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });

  const notes: string[] = [];
  if (tracked.length === 0) {
    log("Kein verfolgter Pool — es gibt nichts nachzuladen.");
    return { pools: 0, upToDate: 0, candles: 0, failed: 0, notes };
  }

  const newest = await deps.store.newestCandleAt(
    tracked.map((pool) => pool.poolAddress),
    timeframe,
  );

  let pools = 0;
  let upToDate = 0;
  let candles = 0;
  let failed = 0;
  let firstError: string | null = null;

  for (const pool of tracked) {
    // Fortsetzen, wo die Historie endet — sonst ab dem Rückblick-Fenster vor der
    // ersten Sichtung. Die letzte vorhandene Kerze wird erneut geholt, weil sie
    // beim vorigen Lauf noch nicht abgeschlossen war.
    const existing = newest.get(pool.poolAddress);
    const from = existing ?? new Date(pool.firstSeenAt.getTime() - lookbackMs);

    if (now.getTime() - from.getTime() < stepMs) {
      upToDate++;
      continue;
    }

    let written = 0;
    let poolFailed = false;
    for (let start = from.getTime(); start < now.getTime(); start += chunkMs) {
      const end = Math.min(start + chunkMs, now.getTime());
      try {
        const fetched = await deps.getHistory(pool.poolAddress, {
          timeframe,
          startTime: new Date(start),
          endTime: new Date(end),
        });
        if (fetched.length > 0) written += await deps.store.recordCandles(fetched);
      } catch (error) {
        // Ein Pool, den die API nicht (mehr) kennt, ist normal. Der Lauf darf
        // daran nicht scheitern — die übrigen Verläufe sind wertvoller.
        poolFailed = true;
        if (firstError === null) firstError = message(error);
        break;
      }
    }

    if (poolFailed) failed++;
    else if (written > 0) pools++;
    else upToDate++;
    candles += written;
  }

  if (firstError !== null) {
    notes.push(`${failed} Pool(s) ohne Historie, erster Fehler: ${firstError}`);
  }
  log(
    `${candles} Kerzen (${timeframe}) für ${pools} Pool(s) nachgeladen` +
      (upToDate > 0 ? `, ${upToDate} waren aktuell` : "") +
      (failed > 0 ? `, ${failed} fehlgeschlagen` : ""),
  );

  return { pools, upToDate, candles, failed, notes };
}

/** Prüft eine Fensterlänge aus der Kommandozeile. */
export function parseTimeframe(value: string | undefined): HistoryTimeframe {
  if (value === undefined) return DEFAULT_TIMEFRAME;
  const match = HISTORY_TIMEFRAMES.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new Error(
      `Unbekannte Fensterlänge "${value}". Erlaubt: ${HISTORY_TIMEFRAMES.join(", ")}`,
    );
  }
  return match;
}

/**
 * Bericht über den Bestand der Historie.
 *
 * Getrennt von der Aufzeichnungs-Statistik, weil beide verschiedene Fragen
 * beantworten: Wie viele **verschiedene Pools** kennt der Datensatz (dort), und
 * wie **dicht und weit zurück** ist ihr Verlauf belegt (hier).
 */
export function formatHistoryStats(stats: {
  pools: number;
  candles: number;
  firstAt: Date | null;
  lastAt: Date | null;
}): string {
  if (stats.candles === 0) {
    return "Historie: noch nichts nachgeladen (`pnpm nachladen`).";
  }
  const lines = [
    `Historie: ${stats.candles} Kerzen für ${stats.pools} Pools`,
  ];
  if (stats.firstAt !== null && stats.lastAt !== null) {
    const spanDays = (stats.lastAt.getTime() - stats.firstAt.getTime()) / 86_400_000;
    lines.push(
      `  Zeitraum ${stats.firstAt.toISOString().slice(0, 16).replace("T", " ")} bis ` +
        `${stats.lastAt.toISOString().slice(0, 16).replace("T", " ")} (${spanDays.toFixed(1)} Tage)`,
    );
    lines.push(
      `  Im Schnitt ${(stats.candles / Math.max(1, stats.pools)).toFixed(0)} Kerzen je Pool.`,
    );
  }
  return lines.join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
