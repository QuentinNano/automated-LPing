import type { Prisma, PrismaClient } from "@prisma/client";
import {
  OUTCOME_HORIZONS_HOURS,
  TIMEFRAME_MINUTES,
  TRACKING_DURATION_HOURS,
  computeOutcomes,
  solPriceUsdOf,
  trackingIntervalSec,
  type FeatureVector,
  type HistoryTimeframe,
  type PoolCandle,
  type PoolMetrics,
  type SnapshotWindows,
  type TrackHealthInput,
  type TrackPoint,
} from "@lping/core";

/**
 * Fensterlänge, in der die Historie geführt wird.
 *
 * Fünf Minuten sind der Zweck der Übung: Ein 24-Stunden-Mittel kann die
 * Volatilitätsphasen nicht auflösen, in denen eine DLMM-Position verdient
 * (KONZEPT-ML.md 3.2). Feiner geht die API nicht.
 */
export const DEFAULT_HISTORY_TIMEFRAME: HistoryTimeframe = "5m";

/**
 * Wie lange ein TVL-Wert nach vorne getragen wird, wenn eine Kerze keinen
 * eigenen hat.
 *
 * Die Historie liefert keinen TVL — er existiert nur als Momentaufnahme in der
 * laufenden Aufzeichnung. Über wenige Stunden ist Forttragen vertretbar; danach
 * ist `null` die ehrlichere Antwort, und die Simulation bucht dann keine
 * Gebühren statt falsche.
 */
const TVL_CARRY_FORWARD_HOURS = 6;

/** Längster Auswertungshorizont — begrenzt, wie weit ein Verlauf gelesen wird. */
const MAX_HORIZON_HOURS = Math.max(...OUTCOME_HORIZONS_HOURS);

/**
 * Karenzzeit, bevor ein fehlendes Label als überfällig gilt.
 *
 * Ein fälliges Label entsteht im nächsten Durchgang, also binnen Minuten. Die
 * Karenz deckt Unterbrechungen ab, nach denen ein Rückstand erst über mehrere
 * Durchgänge abgearbeitet wird — sie soll den Normalbetrieb nicht anschlagen
 * lassen, aber einen echten Stillstand nicht verstecken.
 */
const OUTCOME_GRACE_HOURS = 6;

/**
 * Bedingung „für diesen Horizont ist ein Label fällig, aber nicht vorhanden".
 *
 * Das ist der Kern der Nachberechnung: Ohne die `outcomes: none`-Bedingung
 * liefert die Abfrage immer wieder dieselben ältesten Kandidaten — auch die
 * längst vollständig ausgewerteten. Sobald mehr Kandidaten existieren, als ein
 * Durchgang abarbeitet, bekäme kein neuer Kandidat je ein Label, und zwar
 * lautlos: Die Gesamtzahl der Labels bleibt hoch, sie wächst nur nicht mehr.
 */
function pendingHorizonConditions(
  now: Date,
  graceHours = 0,
): Prisma.CandidateFeatureWhereInput[] {
  return OUTCOME_HORIZONS_HOURS.map((horizonHours) => ({
    capturedAt: {
      lte: new Date(now.getTime() - (horizonHours + graceHours) * 3_600_000),
    },
    outcomes: { none: { horizonHours } },
  }));
}

export interface RecordFeatureInput {
  poolAddress: string;
  tokenMint: string;
  preset: string;
  featureVersion: number;
  features: FeatureVector;
  score: number | null;
  verdict: string;
  rejectedBy: string[];
  capturedAt?: Date;
}

export interface DuePool {
  poolAddress: string;
  tokenMint: string;
  firstSeenAt: Date;
  lastTrackedAt: Date | null;
}

/** Prisma-Decimal in eine Zahl, `null` bleibt `null`. */
function decimal(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

/** Fenster des gleitenden Mittels, das die trägen Volumenraten bildet. */
const SLOW_VOLUME_WINDOW_HOURS = 24;

/**
 * Gleitende 24-Stunden-Rate über eine aufsteigend sortierte Mengenreihe.
 *
 * Je Punkt: Summe der Mengen der zurückliegenden 24 Stunden, hochgerechnet auf
 * den vollen Tag. Am Anfang der Reihe deckt das Fenster weniger ab — dann wird
 * über den **tatsächlich** abgedeckten Zeitraum hochgerechnet statt über 24
 * Stunden, sonst sähe der Beginn jeder Zeitreihe systematisch ruhiger aus, als
 * er war.
 *
 * `null` an Stellen, an denen keine einzige Menge belegt ist — eine erfundene
 * Null wäre hier schlimmer als keine Angabe, weil die Projektion sie als
 * "kein Volumen" lesen würde.
 */
export function trailingDailyRate(
  points: { ts: Date; value: number | null }[],
  intervalMs: number,
): (number | null)[] {
  const windowMs = SLOW_VOLUME_WINDOW_HOURS * 3_600_000;
  const result: (number | null)[] = [];

  let start = 0;
  let sum = 0;
  let count = 0;

  for (let i = 0; i < points.length; i++) {
    const current = points[i]!;
    const value = current.value;
    if (value !== null && Number.isFinite(value)) {
      sum += value;
      count++;
    }
    // Alles aus dem Fenster schieben, was älter als 24 Stunden ist.
    while (start < i && current.ts.getTime() - points[start]!.ts.getTime() > windowMs) {
      const dropped = points[start]!.value;
      if (dropped !== null && Number.isFinite(dropped)) {
        sum -= dropped;
        count--;
      }
      start++;
    }

    // Jede belegte Kerze deckt `intervalMs` ab. Über die tatsächlich belegte
    // Zeit hochzurechnen statt über volle 24 Stunden ist der Punkt: Sonst sähe
    // der Beginn jeder Zeitreihe systematisch ruhiger aus, als er war.
    result.push(count === 0 ? null : (sum * 86_400_000) / (count * intervalMs));
  }

  return result;
}

/**
 * Zeitfenster-Kennzahlen eines Messpunkts als JSON.
 *
 * Leere Fenster werden weggelassen statt als `{}` gespeichert: Bei Millionen
 * Zeilen ist der Unterschied zwischen `null` und vier leeren Objekten relevant,
 * und `null` sagt ehrlich "nicht erhoben".
 */
function snapshotWindows(pool: PoolMetrics): Prisma.InputJsonValue | undefined {
  const windows: SnapshotWindows = {};
  if (Object.keys(pool.volumeUsd).length > 0) windows.volume = pool.volumeUsd;
  if (Object.keys(pool.feesUsd).length > 0) windows.fees = pool.feesUsd;
  if (Object.keys(pool.feeTvlPct).length > 0) windows.feeTvl = pool.feeTvlPct;
  if (Object.keys(pool.protocolFeesUsd).length > 0) {
    windows.protocolFees = pool.protocolFeesUsd;
  }
  return Object.keys(windows).length > 0
    ? (windows as unknown as Prisma.InputJsonValue)
    : undefined;
}

/**
 * Ein Messpunkt als Datenbankzeile.
 *
 * Öffentlich, weil zwei Stellen Messpunkte schreiben: die Aufzeichnung und der
 * Scan. Früher schrieb der Scan eine abgespeckte Variante ohne Gebührenstruktur,
 * SOL-Kurs und Zeitfenster — was in derselben Tabelle zwei Sorten Zeilen ergab,
 * die sich nur beim Lesen unterschieden. Für den Replay ist das gefährlich: Eine
 * Zeile ohne SOL-Kurs liefert keinen Gebührenanteil, sieht aber aus wie ein
 * vollwertiger Messpunkt. Es gibt deshalb genau eine Stelle, die festlegt, was
 * ein Messpunkt enthält.
 */
export function snapshotDataOf(pool: PoolMetrics, ts?: Date) {
  return {
    poolAddress: pool.poolAddress,
    ...(ts !== undefined ? { ts } : {}),
    tvlUsd: pool.tvlUsd ?? null,
    volume24hUsd: pool.volume24hUsd ?? null,
    fees24hUsd: pool.fees24hUsd ?? null,
    feeTvl24hPct: pool.feeTvl24hPct ?? null,
    priceNative: pool.priceNative ?? null,
    binStep: pool.binStep,
    dynamicFeePct: pool.dynamicFeePct ?? null,
    baseFeePct: pool.baseFeePct ?? null,
    protocolFeePct: pool.protocolFeePct ?? null,
    solPriceUsd: solPriceUsdOf(pool),
    windows: snapshotWindows(pool),
  };
}

/** Millisekunden bis zur Fälligkeit; <= 0 bedeutet "jetzt fällig". */
function dueInMs(
  row: { firstSeenAt: Date; lastTrackedAt: Date | null },
  now: Date,
  denseIntervalMin: number,
): number {
  if (row.lastTrackedAt === null) return -1;
  const ageHours = (now.getTime() - row.firstSeenAt.getTime()) / 3_600_000;
  const dueAt = row.lastTrackedAt.getTime() + trackingIntervalSec(ageHours, denseIntervalMin) * 1000;
  return dueAt - now.getTime();
}

/** Eine Zeile des Trainingsdatensatzes: Merkmale + Label eines Horizonts. */
export interface DatasetRow {
  features: FeatureVector;
  preset: string;
  verdict: string;
  capturedAt: Date;
  featureVersion: number;
  outcome: {
    priceChangePct: number | null;
    tvlChangePct: number | null;
    feeYieldPct: number | null;
    maxDrawdownPct: number | null;
    rugged: boolean;
    observations: number;
    coveredHours: number;
  };
}

/**
 * Aufzeichnung für die Strategie-Optimierung (KONZEPT-ML.md Abschnitt 3).
 *
 * Drei Aufgaben: Merkmale zum Entscheidungszeitpunkt festhalten, Pool-Verläufe
 * mitschreiben und daraus Ergebnis-Labels berechnen. Bewusst getrennt von der
 * Positions-Persistenz — der Datensatz soll auch die Pools enthalten, in die
 * nie investiert wurde.
 */
export class TrackRepo {
  constructor(private readonly prisma: PrismaClient) {}

  /** Merkmalsvektor eines gescreenten Kandidaten sichern. */
  async recordFeatures(input: RecordFeatureInput): Promise<string> {
    const row = await this.prisma.candidateFeature.create({
      data: {
        poolAddress: input.poolAddress,
        tokenMint: input.tokenMint,
        preset: input.preset,
        featureVersion: input.featureVersion,
        features: input.features as unknown as Prisma.InputJsonValue,
        score: input.score,
        verdict: input.verdict,
        rejectedBy: input.rejectedBy.length > 0 ? input.rejectedBy.join(", ") : null,
        ...(input.capturedAt !== undefined ? { capturedAt: input.capturedAt } : {}),
      },
      select: { id: true },
    });
    return row.id;
  }

  /**
   * Pool zur Verfolgung anmelden. Ein bereits verfolgter Pool wird nicht
   * verlängert — der Verfolgungszeitraum zählt ab der ersten Sichtung, sonst
   * würden dauerhaft aktive Pools endlos mitlaufen.
   */
  async trackPool(poolAddress: string, tokenMint: string, now: Date = new Date()): Promise<void> {
    await this.prisma.trackedPool.upsert({
      where: { poolAddress },
      create: {
        poolAddress,
        tokenMint,
        firstSeenAt: now,
        trackUntil: new Date(now.getTime() + TRACKING_DURATION_HOURS * 3_600_000),
      },
      update: {},
    });
  }

  /**
   * Pools, deren nächster Messpunkt fällig ist. Das Raster wird dynamisch aus
   * dem Alter bestimmt: die ersten 48 Stunden dicht, danach gröber.
   */
  async duePools(
    now: Date = new Date(),
    limit = 300,
    denseIntervalMin = 15,
  ): Promise<DuePool[]> {
    const rows = await this.prisma.trackedPool.findMany({
      where: { active: true, trackUntil: { gte: now } },
      orderBy: { lastTrackedAt: { sort: "asc", nulls: "first" } },
      take: limit * 2,
      select: { poolAddress: true, tokenMint: true, firstSeenAt: true, lastTrackedAt: true },
    });

    return rows
      .filter((row) => dueInMs(row, now, denseIntervalMin) <= 0)
      .slice(0, limit);
  }

  /**
   * Verfolgte Pools, unabhängig von der Messfälligkeit.
   *
   * Das Nachladen richtet sich nicht nach dem Messraster: Es holt fehlende
   * Historie, und die fehlt auch dann, wenn der nächste Messpunkt noch nicht
   * fällig ist. Standardmäßig auch abgelaufene Verfolgungen — deren Verlauf ist
   * genauso Teil des Datensatzes, nur eben abgeschlossen.
   */
  async trackedPools(
    options: { activeOnly?: boolean; limit?: number } = {},
  ): Promise<{ poolAddress: string; firstSeenAt: Date; trackUntil: Date }[]> {
    return this.prisma.trackedPool.findMany({
      ...(options.activeOnly === true ? { where: { active: true } } : {}),
      orderBy: { firstSeenAt: "asc" },
      ...(options.limit !== undefined ? { take: options.limit } : {}),
      select: { poolAddress: true, firstSeenAt: true, trackUntil: true },
    });
  }

  /**
   * Minuten bis zum nächsten fälligen Messpunkt. Macht ein "0 von N fällig"
   * erklärbar, statt es wie einen Stillstand aussehen zu lassen.
   */
  async nextDueInMinutes(now: Date = new Date(), denseIntervalMin = 15): Promise<number | null> {
    const rows = await this.prisma.trackedPool.findMany({
      where: { active: true, trackUntil: { gte: now } },
      select: { firstSeenAt: true, lastTrackedAt: true },
    });
    if (rows.length === 0) return null;
    const soonest = Math.min(...rows.map((row) => dueInMs(row, now, denseIntervalMin)));
    return Math.max(0, soonest) / 60_000;
  }

  /** Messpunkt schreiben und den Verfolgungsstand fortschreiben. */
  async recordPoint(pool: PoolMetrics, now: Date = new Date()): Promise<void> {
    await this.recordPoints([pool], now);
  }

  /**
   * Messpunkte vieler Pools in **einer** Transaktion.
   *
   * Der Grund ist derselbe wie beim Sammelabruf: Bei einigen tausend verfolgten
   * Pools ist eine Transaktion je Pool der Engpass, nicht die Datenmenge. Ein
   * `createMany` für die Messpunkte plus ein Zähler-Update je Pool geht als ein
   * Stapel zur Datenbank.
   *
   * Pools ohne `tracked_pools`-Eintrag würden das Update sprengen; sie werden
   * vorher herausgefiltert, damit ein verwaister Pool nicht die ganze Runde
   * scheitern lässt.
   */
  async recordPoints(pools: PoolMetrics[], now: Date = new Date()): Promise<number> {
    if (pools.length === 0) return 0;

    const known = await this.prisma.trackedPool.findMany({
      where: { poolAddress: { in: pools.map((pool) => pool.poolAddress) } },
      select: { poolAddress: true },
    });
    const tracked = new Set(known.map((row) => row.poolAddress));
    const writable = pools.filter((pool) => tracked.has(pool.poolAddress));
    if (writable.length === 0) return 0;

    await this.prisma.$transaction([
      this.prisma.poolSnapshot.createMany({
        data: writable.map((pool) => snapshotDataOf(pool, now)),
      }),
      ...writable.map((pool) =>
        this.prisma.trackedPool.update({
          where: { poolAddress: pool.poolAddress },
          data: { lastTrackedAt: now, pointCount: { increment: 1 } },
        }),
      ),
    ]);

    return writable.length;
  }

  /**
   * Nachgeladene Kerzen sichern.
   *
   * Ersetzt den abgedeckten Zeitraum statt zu ergänzen: Die jüngste Kerze ist
   * beim Abruf noch nicht abgeschlossen und ändert sich, und ein zweiter Lauf
   * über denselben Zeitraum soll denselben Bestand ergeben — nicht doppelte
   * Zeilen und nicht veraltete Werte.
   */
  async recordCandles(candles: PoolCandle[]): Promise<number> {
    if (candles.length === 0) return 0;

    const groups = new Map<string, PoolCandle[]>();
    for (const candle of candles) {
      const key = `${candle.poolAddress} ${candle.timeframe}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [candle]);
      else group.push(candle);
    }

    let written = 0;
    for (const group of groups.values()) {
      const first = group[0]!;
      const times = group.map((candle) => candle.ts.getTime());
      const from = new Date(Math.min(...times));
      const to = new Date(Math.max(...times));

      await this.prisma.$transaction([
        this.prisma.poolHistoryCandle.deleteMany({
          where: {
            poolAddress: first.poolAddress,
            timeframe: first.timeframe,
            ts: { gte: from, lte: to },
          },
        }),
        this.prisma.poolHistoryCandle.createMany({
          data: group.map((candle) => ({
            poolAddress: candle.poolAddress,
            timeframe: candle.timeframe,
            ts: candle.ts,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volumeUsd: candle.volumeUsd,
            feesUsd: candle.feesUsd,
            protocolFeesUsd: candle.protocolFeesUsd,
          })),
        }),
      ]);
      written += group.length;
    }

    return written;
  }

  /** Abgelaufene Verfolgungen stilllegen. */
  async deactivateExpired(now: Date = new Date()): Promise<number> {
    const result = await this.prisma.trackedPool.updateMany({
      where: { active: true, trackUntil: { lt: now } },
      data: { active: false },
    });
    return result.count;
  }

  /**
   * Berechnet fehlende Ergebnis-Labels.
   *
   * Ein Label wird erst geschrieben, wenn sein Horizont **vollständig
   * verstrichen** ist — ein nach zwei Stunden berechnetes 24-Stunden-Label
   * wäre systematisch verzerrt.
   *
   * Ausgewählt werden ausschließlich Kandidaten mit mindestens einem fälligen,
   * aber fehlenden Label (siehe `pendingHorizonConditions`). Fertige Kandidaten
   * dürfen den Stapel nicht belegen, sonst bleibt die Nachberechnung an den
   * ältesten Zeilen hängen und neue Kandidaten bekommen nie ein Label.
   *
   * Ein Horizont ohne Messpunkte bekommt ein **leeres** Label statt gar keines.
   * Das ist Absicht: Auch „in diesem Zeitraum wurde nichts aufgezeichnet" ist
   * ein Ergebnis, und nur so verlässt der Kandidat den Stapel. Für das Training
   * ist die Zeile unschädlich — `exportDataset` und `datasetQuality` verlangen
   * beide `observations >= 2` und fangen sie ab.
   */
  async computeDueOutcomes(now: Date = new Date(), limit = 200): Promise<number> {
    const features = await this.prisma.candidateFeature.findMany({
      where: { OR: pendingHorizonConditions(now) },
      orderBy: { capturedAt: "asc" },
      take: limit,
      select: {
        id: true,
        poolAddress: true,
        capturedAt: true,
        outcomes: { select: { horizonHours: true } },
      },
    });

    const rows: Prisma.CandidateOutcomeCreateManyInput[] = [];
    for (const feature of features) {
      const done = new Set(feature.outcomes.map((o) => o.horizonHours));
      // Über den längsten Horizont hinaus sieht kein Label — den Rest des
      // Verlaufs zu laden kostet nur Speicher und wächst mit der Laufzeit.
      const until = new Date(feature.capturedAt.getTime() + MAX_HORIZON_HOURS * 3_600_000);
      // Derselbe Lesepfad wie der Replay: Labels und Optimierung müssen
      // dieselbe Zeitreihe sehen. Nebeneffekt, der die Labels ehrlicher macht:
      // Wo Kerzen vorliegen, misst `maxDrawdownPct` den Einbruch über `low`,
      // statt ihn zwischen zwei Stichproben zu verpassen.
      const points = await this.loadSeries(feature.poolAddress, feature.capturedAt, until);

      for (const label of computeOutcomes(feature.capturedAt, points)) {
        if (done.has(label.horizonHours)) continue;
        const horizonEnd = feature.capturedAt.getTime() + label.horizonHours * 3_600_000;
        if (horizonEnd > now.getTime()) continue;

        rows.push({
          featureId: feature.id,
          horizonHours: label.horizonHours,
          priceChangePct: label.priceChangePct,
          tvlChangePct: label.tvlChangePct,
          feeYieldPct: label.feeYieldPct,
          maxDrawdownPct: label.maxDrawdownPct,
          rugged: label.rugged,
          observations: label.observations,
          coveredHours: label.coveredHours,
        });
      }
    }

    if (rows.length === 0) return 0;
    // Ein Insert statt einem je Label. `skipDuplicates` deckt den Fall ab, dass
    // zwei Aufzeichner gleichzeitig laufen — die Eindeutigkeit erzwingt ohnehin
    // der Index auf (feature_id, horizon_hours).
    const result = await this.prisma.candidateOutcome.createMany({
      data: rows,
      skipDuplicates: true,
    });
    return result.count;
  }

  /**
   * Fällige, aber fehlende Labels jenseits der Karenzzeit.
   *
   * Die Kennzahl, an der ein Stillstand der Nachberechnung sichtbar wird: Die
   * bloße Anzahl berechneter Labels bleibt dabei hoch und sieht gesund aus.
   */
  async overdueOutcomes(now: Date = new Date()): Promise<number> {
    const counts = await Promise.all(
      pendingHorizonConditions(now, OUTCOME_GRACE_HOURS).map((where) =>
        this.prisma.candidateFeature.count({ where }),
      ),
    );
    return counts.reduce((sum, count) => sum + count, 0);
  }

  /**
   * Zeitreihe eines Pools ab einem Zeitpunkt. Öffentlich, weil der Replay
   * (KONZEPT-ML.md 5) genau diesen Lesepfad braucht — Replay und Label-Berechnung
   * müssen dieselben Punkte sehen, sonst optimiert man gegen andere Daten als die,
   * mit denen man später bewertet.
   */
  async loadTrack(poolAddress: string, since: Date, until?: Date): Promise<TrackPoint[]> {
    const rows = await this.prisma.poolSnapshot.findMany({
      where: {
        poolAddress,
        ts: { gte: since, ...(until !== undefined ? { lte: until } : {}) },
      },
      orderBy: { ts: "asc" },
      select: {
        ts: true,
        priceNative: true,
        tvlUsd: true,
        fees24hUsd: true,
        volume24hUsd: true,
        dynamicFeePct: true,
        baseFeePct: true,
        protocolFeePct: true,
        solPriceUsd: true,
        windows: true,
      },
    });
    return rows.map((row) => ({
      ts: row.ts,
      priceNative: decimal(row.priceNative),
      tvlUsd: decimal(row.tvlUsd),
      fees24hUsd: decimal(row.fees24hUsd),
      volume24hUsd: decimal(row.volume24hUsd),
      dynamicFeePct: decimal(row.dynamicFeePct),
      baseFeePct: decimal(row.baseFeePct),
      protocolFeePct: decimal(row.protocolFeePct),
      solPriceUsd: decimal(row.solPriceUsd),
      windows: (row.windows as SnapshotWindows | null) ?? null,
    }));
  }

  /**
   * Zeitreihe aus **nachgeladenen Kerzen**, ergänzt um den TVL aus der
   * laufenden Aufzeichnung.
   *
   * Die Arbeitsteilung ist keine Bequemlichkeit, sondern folgt daraus, was
   * abrufbar ist: Preis, Volumen und Gebühren kommen fein aufgelöst aus der
   * Historie, den TVL gibt es nur als Momentaufnahme. Er wird deshalb vom
   * jeweils letzten Messpunkt nach vorne getragen — höchstens
   * `TVL_CARRY_FORWARD_HOURS` lang, danach `null`.
   *
   * Umrechnung der Mengen in Raten: Die Paper-Engine erwartet
   * `volume24hUsd`/`fees24hUsd` als **24-Stunden-Rate** und skaliert selbst auf
   * das abgelaufene Intervall. Eine Kerze ist eine Menge; sie wird hier mit
   * `1440 / Fensterminuten` hochgerechnet. Der Gebührensatz bleibt davon
   * unberührt, weil sich der Faktor im Quotienten kürzt.
   *
   * Der Protokollanteil wird je Kerze aus `protocol_fees / fees` gerechnet —
   * gemessen statt aus der Pool-Konfiguration geschätzt.
   */
  async loadHistory(
    poolAddress: string,
    since: Date,
    until: Date,
    options: { timeframe?: HistoryTimeframe } = {},
  ): Promise<TrackPoint[]> {
    const timeframe = options.timeframe ?? DEFAULT_HISTORY_TIMEFRAME;
    const carryMs = TVL_CARRY_FORWARD_HOURS * 3_600_000;

    const [candles, snapshots] = await Promise.all([
      this.prisma.poolHistoryCandle.findMany({
        where: { poolAddress, timeframe, ts: { gte: since, lte: until } },
        orderBy: { ts: "asc" },
      }),
      this.prisma.poolSnapshot.findMany({
        where: { poolAddress, ts: { gte: new Date(since.getTime() - carryMs), lte: until } },
        orderBy: { ts: "asc" },
        select: { ts: true, tvlUsd: true, solPriceUsd: true },
      }),
    ]);

    const perDay = 1440 / TIMEFRAME_MINUTES[timeframe];
    const slowVolume = trailingDailyRate(
      candles.map((candle) => ({ ts: candle.ts, value: decimal(candle.volumeUsd) })),
      TIMEFRAME_MINUTES[timeframe] * 60_000,
    );

    let index = 0;
    let tvlUsd: number | null = null;
    let solPriceUsd: number | null = null;
    let carriedAtMs = Number.NEGATIVE_INFINITY;

    return candles.map((candle, position) => {
      const tsMs = candle.ts.getTime();
      // Alle Messpunkte bis zu dieser Kerze einarbeiten (beide Listen sind
      // aufsteigend sortiert, also genügt ein Durchlauf über beide).
      while (index < snapshots.length && snapshots[index]!.ts.getTime() <= tsMs) {
        const row = snapshots[index]!;
        const tvl = decimal(row.tvlUsd);
        if (tvl !== null) {
          tvlUsd = tvl;
          carriedAtMs = row.ts.getTime();
        }
        const solPrice = decimal(row.solPriceUsd);
        if (solPrice !== null) solPriceUsd = solPrice;
        index++;
      }

      const stale = tsMs - carriedAtMs > carryMs;
      const volume = decimal(candle.volumeUsd);
      const fees = decimal(candle.feesUsd);
      const protocolFees = decimal(candle.protocolFeesUsd);

      return {
        ts: candle.ts,
        priceNative: decimal(candle.close) ?? decimal(candle.open),
        high: decimal(candle.high),
        low: decimal(candle.low),
        tvlUsd: stale ? null : tvlUsd,
        solPriceUsd: stale ? null : solPriceUsd,
        volume24hUsd: volume === null ? null : volume * perDay,
        // Dieselbe Größe aus einem trägen Fenster — die Projektion des
        // Rebalance-EV darf nicht auf einer einzelnen Kerze stehen.
        volume24hUsdSlow: slowVolume[position] ?? null,
        fees24hUsd: fees === null ? null : fees * perDay,
        protocolFeePct:
          fees !== null && fees > 0 && protocolFees !== null
            ? (protocolFees / fees) * 100
            : null,
        // Die Historie kennt die dynamische Gebühr nicht. `effectiveFeePct`
        // fällt damit auf die realisierte Rate aus Gebühren/Volumen zurück —
        // die für eine Kerze genauer ist als jede Momentaufnahme.
        dynamicFeePct: null,
        baseFeePct: null,
        // Keine gleitenden Fenster erfinden: Eine Kerze ist kein Fenster.
        windows: null,
      };
    });
  }

  /**
   * Zeitreihe eines Pools aus **beiden** Quellen — der Lesepfad für Replay und
   * Label-Berechnung.
   *
   * Es gibt genau einen solchen Pfad, und das ist Absicht (KONZEPT-ML.md 5):
   * Sobald Optimierung und Auswertung verschiedene Zeitreihen sehen, optimiert
   * man gegen die eine und bewertet mit der anderen.
   *
   * Regel: **Kerzen bilden das Raster, wo es sie gibt.** Sie sind feiner
   * aufgelöst und tragen High/Low; die Messpunkte steuern den TVL bei (siehe
   * `loadHistory`). Ein Messpunkt kommt nur dann als eigener Punkt dazu, wenn in
   * seiner Nähe keine Kerze liegt — sonst stünden zwei Beobachtungen desselben
   * Moments in der Reihe, und die Simulation zählte das Intervall doppelt.
   */
  async loadSeries(
    poolAddress: string,
    since: Date,
    until: Date,
    options: { timeframe?: HistoryTimeframe } = {},
  ): Promise<TrackPoint[]> {
    const timeframe = options.timeframe ?? DEFAULT_HISTORY_TIMEFRAME;
    const [candles, snapshots] = await Promise.all([
      this.loadHistory(poolAddress, since, until, { timeframe }),
      this.loadTrack(poolAddress, since, until),
    ]);

    if (candles.length === 0) return snapshots;
    if (snapshots.length === 0) return candles;

    const stepMs = TIMEFRAME_MINUTES[timeframe] * 60_000;
    const merged = [...candles];

    // Beide Listen sind aufsteigend sortiert, ein Durchlauf genügt.
    let index = 0;
    for (const point of snapshots) {
      const ts = point.ts.getTime();
      while (index + 1 < candles.length && candles[index + 1]!.ts.getTime() <= ts) index++;
      const before = Math.abs(ts - candles[index]!.ts.getTime());
      const after =
        index + 1 < candles.length
          ? Math.abs(candles[index + 1]!.ts.getTime() - ts)
          : Number.POSITIVE_INFINITY;
      if (Math.min(before, after) > stepMs) merged.push(point);
    }

    merged.sort((a, b) => a.ts.getTime() - b.ts.getTime());
    return merged;
  }

  /**
   * Jüngste Kerze je Pool — der Startpunkt eines Nachlade-Laufs.
   *
   * Ohne diese Auskunft würde jeder Lauf den gesamten Zeitraum neu holen. Mit
   * ihr holt er nur, was fehlt.
   */
  async newestCandleAt(
    poolAddresses: string[],
    timeframe: HistoryTimeframe = DEFAULT_HISTORY_TIMEFRAME,
  ): Promise<Map<string, Date>> {
    if (poolAddresses.length === 0) return new Map();
    const rows = await this.prisma.poolHistoryCandle.groupBy({
      by: ["poolAddress"],
      where: { poolAddress: { in: poolAddresses }, timeframe },
      _max: { ts: true },
    });
    const newest = new Map<string, Date>();
    for (const row of rows) {
      if (row._max.ts !== null) newest.set(row.poolAddress, row._max.ts);
    }
    return newest;
  }

  /**
   * Stammdaten für den Replay: Mints und Bin Step je Pool.
   *
   * Die Zeitreihe allein reicht nicht. Sie enthält `price_native` genau so, wie
   * die API sie liefert — den Preis von X in Y —, und ob das der Token in SOL
   * oder SOL im Token ist, steht nur in den Mints. Ohne sie läge jede
   * Bin-Zuordnung falsch herum.
   *
   * Quelle sind die gescreenten Kandidaten: Dort liegen die vollständigen
   * Pool-Metriken des Entdeckungszeitpunkts. Ein verfolgter Pool ohne
   * Kandidatenzeile lässt sich nicht abspielen und fehlt im Ergebnis.
   */
  async replayPools(
    poolAddresses?: string[],
  ): Promise<{ poolAddress: string; mintX: string; mintY: string; binStep: number }[]> {
    const rows = await this.prisma.poolCandidate.findMany({
      ...(poolAddresses !== undefined ? { where: { poolAddress: { in: poolAddresses } } } : {}),
      orderBy: { discoveredAt: "desc" },
      distinct: ["poolAddress"],
      select: { poolAddress: true, rawMetrics: true },
    });

    return rows.flatMap((row) => {
      const metrics = row.rawMetrics as { mintX?: unknown; mintY?: unknown; binStep?: unknown };
      const { mintX, mintY, binStep } = metrics;
      if (typeof mintX !== "string" || typeof mintY !== "string" || typeof binStep !== "number") {
        return [];
      }
      return [{ poolAddress: row.poolAddress, mintX, mintY, binStep }];
    });
  }

  /** Bestand der nachgeladenen Historie, für Bericht und Fortschritt. */
  async historyStats(
    timeframe: HistoryTimeframe = DEFAULT_HISTORY_TIMEFRAME,
  ): Promise<{ pools: number; candles: number; firstAt: Date | null; lastAt: Date | null }> {
    const [candles, bounds, distinct] = await Promise.all([
      this.prisma.poolHistoryCandle.count({ where: { timeframe } }),
      this.prisma.poolHistoryCandle.aggregate({
        where: { timeframe },
        _min: { ts: true },
        _max: { ts: true },
      }),
      this.prisma.poolHistoryCandle.findMany({
        where: { timeframe },
        distinct: ["poolAddress"],
        select: { poolAddress: true },
      }),
    ]);
    return {
      pools: distinct.length,
      candles,
      firstAt: bounds._min.ts ?? null,
      lastAt: bounds._max.ts ?? null,
    };
  }

  /** Kennzahlen für die Fortschrittsanzeige des Strategie-Labors. */
  async stats(now: Date = new Date()): Promise<{
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
  }> {
    const [trackedActive, trackedTotal, points, features, outcomes, first, distinct] =
      await Promise.all([
        this.prisma.trackedPool.count({ where: { active: true } }),
        this.prisma.trackedPool.count(),
        this.prisma.poolSnapshot.count(),
        this.prisma.candidateFeature.count(),
        this.prisma.candidateOutcome.count(),
        this.prisma.candidateFeature.findFirst({
          orderBy: { capturedAt: "asc" },
          select: { capturedAt: true },
        }),
        // COUNT(DISTINCT …) statt groupBy: Bei Millionen Zeilen soll die
        // Zählung in der Datenbank bleiben, nicht als Zeilenmenge herüberkommen.
        this.prisma.$queryRaw<{ candidates: bigint; pools: bigint }[]>`
          SELECT
            COUNT(DISTINCT (pool_address, preset)) AS candidates,
            COUNT(DISTINCT pool_address)           AS pools
          FROM candidate_features
        `,
      ]);

    const firstCaptureAt = first?.capturedAt ?? null;
    return {
      trackedActive,
      trackedTotal,
      points,
      features,
      distinctCandidates: Number(distinct[0]?.candidates ?? 0),
      distinctPools: Number(distinct[0]?.pools ?? 0),
      outcomes,
      firstCaptureAt,
      recordingDays:
        firstCaptureAt === null
          ? 0
          : (now.getTime() - firstCaptureAt.getTime()) / 86_400_000,
    };
  }

  /**
   * Kennzahlen für die Beurteilung der Aufzeichnung. Die Bewertung selbst
   * passiert in @lping/core (evaluateTrackHealth) — hier wird nur gemessen.
   */
  async healthMetrics(now: Date = new Date(), expectedIntervalMin = 15): Promise<TrackHealthInput> {
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const sixHoursAgo = new Date(now.getTime() - 6 * 3_600_000);
    const dayAgo = new Date(now.getTime() - 24 * 3_600_000);

    const [
      trackedActive,
      newest,
      pointsLastHour,
      featuresLast6h,
      featuresTotal,
      outcomesTotal,
      overdueOutcomes,
      oldest,
    ] = await Promise.all([
      this.prisma.trackedPool.count({ where: { active: true } }),
      this.prisma.poolSnapshot.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
      this.prisma.poolSnapshot.count({ where: { ts: { gte: hourAgo } } }),
      this.prisma.candidateFeature.count({ where: { capturedAt: { gte: sixHoursAgo } } }),
      this.prisma.candidateFeature.count(),
      this.prisma.candidateOutcome.count(),
      this.overdueOutcomes(now),
      this.prisma.candidateFeature.findFirst({
        orderBy: { capturedAt: "asc" },
        select: { capturedAt: true },
      }),
    ]);

    const distinctPools = await this.prisma.poolSnapshot.findMany({
      where: { ts: { gte: hourAgo } },
      distinct: ["poolAddress"],
      select: { poolAddress: true },
    });

    // Belegungsgrad der Merkmale in einer Stichprobe der jüngsten Aufzeichnungen:
    // zeigt, ob eine Datenquelle still ausgefallen ist.
    const sample = await this.prisma.candidateFeature.findMany({
      orderBy: { capturedAt: "desc" },
      take: 100,
      select: { features: true },
    });
    const fieldCoverage: Record<string, number> = {};
    if (sample.length > 0) {
      for (const key of [
        "tvl_usd",
        "token_age_hours",
        "risk_score",
        "roundtrip_loss_pct",
        "organic_score",
        // Felder aus Merkmalsschema v2. Fehlen sie in den jüngsten
        // Aufzeichnungen, läuft der Aufzeichner noch mit altem Code — der
        // Datensatz verarmt dann still.
        "dynamic_fee_pct",
        "fee_tvl_1h_pct",
        "collect_fee_mode",
      ]) {
        const filled = sample.filter((row) => {
          const features = row.features as Record<string, unknown> | null;
          return features !== null && features[key] !== null && features[key] !== undefined;
        }).length;
        fieldCoverage[key] = filled / sample.length;
      }
    }

    return {
      now,
      trackedActive,
      newestPointAt: newest?.ts ?? null,
      pointsLastHour,
      poolsWithPointLastHour: distinctPools.length,
      featuresLast6h,
      featuresTotal,
      outcomesTotal,
      overdueOutcomes,
      oldestFeatureAt: oldest?.capturedAt ?? null,
      fieldCoverage,
      largestGapMinutes: await this.largestGapMinutes(dayAgo, now),
      expectedIntervalMin,
    };
  }

  /**
   * Größte Unterbrechung der letzten 24 Stunden, ausgewertet über Stundenblöcke
   * statt Einzelzeitpunkte — das bleibt auch bei vielen tausend Messpunkten günstig.
   */
  private async largestGapMinutes(since: Date, now: Date): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ hour: Date }[]>`
      SELECT DISTINCT date_trunc('hour', ts) AS hour
      FROM pool_snapshots
      WHERE ts >= ${since}
      ORDER BY hour ASC
    `;
    if (rows.length === 0) return null;

    let largest = 0;
    let previous = since;
    for (const row of rows) {
      const gap = (row.hour.getTime() - previous.getTime()) / 60_000;
      if (gap > largest) largest = gap;
      previous = new Date(row.hour.getTime() + 3_600_000);
    }
    // Auch die Zeit seit dem letzten belegten Block zählt als Lücke.
    return Math.max(largest, Math.max(0, (now.getTime() - previous.getTime()) / 60_000));
  }

  /**
   * Trainingsdatensatz: Merkmale samt Labels eines Horizonts.
   *
   * Die Qualitätsangaben (`observations`, `coveredHours`) werden mitgegeben,
   * damit lückenhaft belegte Labels vor dem Training aussortiert werden können.
   * Ein 24-Stunden-Label, das nur drei Stunden abdeckt, ist kein 24-Stunden-Label
   * — bei zeitweise unterbrochener Aufzeichnung ist das der Regelfall.
   *
   * `minCoverageRatio` verlangt einen Mindestanteil des Horizonts (Default 0,7).
   *
   * `featureVersion` grenzt auf ein Merkmalsschema ein. Ohne die Angabe kommen
   * Zeilen verschiedener Versionen gemischt zurück — die haben unterschiedliche
   * Spalten, und ein Modell darauf zu trainieren erzeugt stillschweigend
   * fehlende Werte statt eines Fehlers. `featureVersions()` zeigt, was vorliegt.
   */
  async exportDataset(
    horizonHours: number,
    options: {
      minCoverageRatio?: number;
      minObservations?: number;
      featureVersion?: number;
    } = {},
  ): Promise<DatasetRow[]> {
    const minCoverage = (options.minCoverageRatio ?? 0.7) * horizonHours;
    const minObservations = options.minObservations ?? 2;

    const rows = await this.prisma.candidateFeature.findMany({
      where: {
        ...(options.featureVersion !== undefined
          ? { featureVersion: options.featureVersion }
          : {}),
        outcomes: {
          some: {
            horizonHours,
            coveredHours: { gte: minCoverage },
            observations: { gte: minObservations },
          },
        },
      },
      orderBy: { capturedAt: "asc" },
      select: {
        features: true,
        preset: true,
        verdict: true,
        capturedAt: true,
        featureVersion: true,
        outcomes: { where: { horizonHours }, take: 1 },
      },
    });

    return rows.flatMap((row) => {
      const outcome = row.outcomes[0];
      if (outcome === undefined) return [];
      return [
        {
          features: row.features as unknown as FeatureVector,
          preset: row.preset,
          verdict: row.verdict,
          capturedAt: row.capturedAt,
          featureVersion: row.featureVersion,
          outcome: {
            priceChangePct: outcome.priceChangePct === null ? null : Number(outcome.priceChangePct),
            tvlChangePct: outcome.tvlChangePct === null ? null : Number(outcome.tvlChangePct),
            feeYieldPct: outcome.feeYieldPct === null ? null : Number(outcome.feeYieldPct),
            maxDrawdownPct:
              outcome.maxDrawdownPct === null ? null : Number(outcome.maxDrawdownPct),
            rugged: outcome.rugged,
            observations: outcome.observations,
            coveredHours: Number(outcome.coveredHours),
          },
        },
      ];
    });
  }

  /**
   * Welche Merkmalsschemata liegen im Datensatz vor, mit Zeitraum und Anzahl?
   *
   * Nach einer Schema-Erweiterung enthält die Aufzeichnung zwangsläufig beide
   * Versionen. Ohne diese Übersicht bemerkt man das erst beim Training — und
   * dann sieht es aus wie fehlende Daten, nicht wie zwei Schemata.
   */
  async featureVersions(): Promise<
    { featureVersion: number; count: number; firstAt: Date; lastAt: Date }[]
  > {
    const grouped = await this.prisma.candidateFeature.groupBy({
      by: ["featureVersion"],
      _count: { _all: true },
      _min: { capturedAt: true },
      _max: { capturedAt: true },
      orderBy: { featureVersion: "asc" },
    });

    return grouped.flatMap((row) => {
      const firstAt = row._min.capturedAt;
      const lastAt = row._max.capturedAt;
      if (firstAt === null || lastAt === null) return [];
      return [{ featureVersion: row.featureVersion, count: row._count._all, firstAt, lastAt }];
    });
  }

  /**
   * Wie viele Labels je Horizont sind vollständig genug zum Trainieren?
   * Macht sichtbar, was Aufzeichnungslücken tatsächlich gekostet haben.
   */
  async datasetQuality(
    horizons: readonly number[],
    minCoverageRatio = 0.7,
  ): Promise<{ horizonHours: number; total: number; usable: number }[]> {
    const result: { horizonHours: number; total: number; usable: number }[] = [];
    for (const horizonHours of horizons) {
      const [total, usable] = await Promise.all([
        this.prisma.candidateOutcome.count({ where: { horizonHours } }),
        this.prisma.candidateOutcome.count({
          where: {
            horizonHours,
            coveredHours: { gte: minCoverageRatio * horizonHours },
            observations: { gte: 2 },
          },
        }),
      ]);
      result.push({ horizonHours, total, usable });
    }
    return result;
  }
}
