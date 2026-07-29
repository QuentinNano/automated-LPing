import type { Prisma, PrismaClient } from "@prisma/client";
import {
  TRACKING_DURATION_HOURS,
  computeOutcomes,
  trackingIntervalSec,
  type FeatureVector,
  type PoolMetrics,
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
  async duePools(now: Date = new Date(), limit = 300): Promise<DuePool[]> {
    const rows = await this.prisma.trackedPool.findMany({
      where: { active: true, trackUntil: { gte: now } },
      orderBy: { lastTrackedAt: { sort: "asc", nulls: "first" } },
      take: limit * 2,
      select: { poolAddress: true, tokenMint: true, firstSeenAt: true, lastTrackedAt: true },
    });

    return rows
      .filter((row) => {
        if (row.lastTrackedAt === null) return true;
        const ageHours = (now.getTime() - row.firstSeenAt.getTime()) / 3_600_000;
        const dueAfterMs = trackingIntervalSec(ageHours) * 1000;
        return now.getTime() - row.lastTrackedAt.getTime() >= dueAfterMs;
      })
      .slice(0, limit);
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

  /** Trainingsdatensatz: Merkmale samt Labels eines Horizonts. */
  async exportDataset(horizonHours: number): Promise<
    { features: FeatureVector; preset: string; verdict: string; capturedAt: Date; outcome: {
      priceChangePct: number | null;
      tvlChangePct: number | null;
      feeYieldPct: number | null;
      maxDrawdownPct: number | null;
      rugged: boolean;
    } }[]
  > {
    const rows = await this.prisma.candidateFeature.findMany({
      where: { outcomes: { some: { horizonHours } } },
      orderBy: { capturedAt: "asc" },
      select: {
        features: true,
        preset: true,
        verdict: true,
        capturedAt: true,
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
          outcome: {
            priceChangePct: outcome.priceChangePct === null ? null : Number(outcome.priceChangePct),
            tvlChangePct: outcome.tvlChangePct === null ? null : Number(outcome.tvlChangePct),
            feeYieldPct: outcome.feeYieldPct === null ? null : Number(outcome.feeYieldPct),
            maxDrawdownPct:
              outcome.maxDrawdownPct === null ? null : Number(outcome.maxDrawdownPct),
            rugged: outcome.rugged,
          },
        },
      ];
    });
  }
}
