import type { Prisma, PrismaClient } from "@prisma/client";
import {
  TRACKING_DURATION_HOURS,
  computeOutcomes,
  trackingIntervalSec,
  type FeatureVector,
  type PoolMetrics,
  type TrackHealthInput,
  type TrackPoint,
} from "@lping/core";

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
    await this.prisma.$transaction([
      this.prisma.poolSnapshot.create({
        data: {
          poolAddress: pool.poolAddress,
          ts: now,
          tvlUsd: pool.tvlUsd ?? null,
          volume24hUsd: pool.volume24hUsd ?? null,
          fees24hUsd: pool.fees24hUsd ?? null,
          feeTvl24hPct: pool.feeTvl24hPct ?? null,
          priceNative: pool.priceNative ?? null,
          binStep: pool.binStep,
        },
      }),
      this.prisma.trackedPool.update({
        where: { poolAddress: pool.poolAddress },
        data: { lastTrackedAt: now, pointCount: { increment: 1 } },
      }),
    ]);
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
   */
  async computeDueOutcomes(now: Date = new Date(), limit = 200): Promise<number> {
    const features = await this.prisma.candidateFeature.findMany({
      where: { capturedAt: { lte: new Date(now.getTime() - 3_600_000) } },
      orderBy: { capturedAt: "asc" },
      take: limit,
      select: {
        id: true,
        poolAddress: true,
        capturedAt: true,
        outcomes: { select: { horizonHours: true } },
      },
    });

    let written = 0;
    for (const feature of features) {
      const done = new Set(feature.outcomes.map((o) => o.horizonHours));
      const points = await this.loadTrack(feature.poolAddress, feature.capturedAt);
      if (points.length === 0) continue;

      for (const label of computeOutcomes(feature.capturedAt, points)) {
        if (done.has(label.horizonHours)) continue;
        const horizonEnd = feature.capturedAt.getTime() + label.horizonHours * 3_600_000;
        if (horizonEnd > now.getTime()) continue;
        if (label.observations === 0) continue;

        await this.prisma.candidateOutcome.create({
          data: {
            featureId: feature.id,
            horizonHours: label.horizonHours,
            priceChangePct: label.priceChangePct,
            tvlChangePct: label.tvlChangePct,
            feeYieldPct: label.feeYieldPct,
            maxDrawdownPct: label.maxDrawdownPct,
            rugged: label.rugged,
            observations: label.observations,
            coveredHours: label.coveredHours,
          },
        });
        written++;
      }
    }
    return written;
  }

  private async loadTrack(poolAddress: string, since: Date): Promise<TrackPoint[]> {
    const rows = await this.prisma.poolSnapshot.findMany({
      where: { poolAddress, ts: { gte: since } },
      orderBy: { ts: "asc" },
      select: {
        ts: true,
        priceNative: true,
        tvlUsd: true,
        fees24hUsd: true,
        volume24hUsd: true,
      },
    });
    return rows.map((row) => ({
      ts: row.ts,
      priceNative: row.priceNative === null ? null : Number(row.priceNative),
      tvlUsd: row.tvlUsd === null ? null : Number(row.tvlUsd),
      fees24hUsd: row.fees24hUsd === null ? null : Number(row.fees24hUsd),
      volume24hUsd: row.volume24hUsd === null ? null : Number(row.volume24hUsd),
    }));
  }

  /** Kennzahlen für die Fortschrittsanzeige des Strategie-Labors. */
  async stats(now: Date = new Date()): Promise<{
    trackedActive: number;
    trackedTotal: number;
    points: number;
    features: number;
    outcomes: number;
    firstCaptureAt: Date | null;
    recordingDays: number;
  }> {
    const [trackedActive, trackedTotal, points, features, outcomes, first] = await Promise.all([
      this.prisma.trackedPool.count({ where: { active: true } }),
      this.prisma.trackedPool.count(),
      this.prisma.poolSnapshot.count(),
      this.prisma.candidateFeature.count(),
      this.prisma.candidateOutcome.count(),
      this.prisma.candidateFeature.findFirst({
        orderBy: { capturedAt: "asc" },
        select: { capturedAt: true },
      }),
    ]);

    const firstCaptureAt = first?.capturedAt ?? null;
    return {
      trackedActive,
      trackedTotal,
      points,
      features,
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

    const [trackedActive, newest, pointsLastHour, featuresLast6h, featuresTotal, outcomesTotal, oldest] =
      await Promise.all([
        this.prisma.trackedPool.count({ where: { active: true } }),
        this.prisma.poolSnapshot.findFirst({ orderBy: { ts: "desc" }, select: { ts: true } }),
        this.prisma.poolSnapshot.count({ where: { ts: { gte: hourAgo } } }),
        this.prisma.candidateFeature.count({ where: { capturedAt: { gte: sixHoursAgo } } }),
        this.prisma.candidateFeature.count(),
        this.prisma.candidateOutcome.count(),
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
   */
  async exportDataset(
    horizonHours: number,
    options: { minCoverageRatio?: number; minObservations?: number } = {},
  ): Promise<DatasetRow[]> {
    const minCoverage = (options.minCoverageRatio ?? 0.7) * horizonHours;
    const minObservations = options.minObservations ?? 2;

    const rows = await this.prisma.candidateFeature.findMany({
      where: {
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
