import type { Prisma, PrismaClient } from "@prisma/client";
import type { CandidateSource, PoolMetrics, PresetKind, ScreeningResult } from "@lping/core";

/** Ergebnis einer Kandidaten-Persistierung. */
export interface RecordedCandidate {
  candidateId: string;
  created: boolean;
}

export interface ScanRecordInput {
  poolAddress: string;
  preset: PresetKind;
  source: CandidateSource;
  pool: PoolMetrics;
  screening: ScreeningResult;
}

const SHADOW_TRACKING_DAYS = 7;
const DEDUPE_WINDOW_HOURS = 24;

/**
 * Persistenz der Scan-Ergebnisse (KONZEPT.md Abschnitte 5.5 und 10.2):
 * - pool_candidates: ein Eintrag je Pool+Preset innerhalb des Dedupe-Fensters,
 *   bei erneutem Scan aktualisiert (Score/Filter-Ergebnis/Status).
 * - Abgelehnte erhalten shadowUntil (+7 Tage) für die Filter-Kalibrierung.
 * - pool_snapshots: Zeitreihe pro Scan für aktive UND geschattete Pools.
 */
export class ScanRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async recordScreened(input: ScanRecordInput): Promise<RecordedCandidate> {
    const status = input.screening.verdict === "accepted" ? "DISCOVERED" : "REJECTED";
    const shadowUntil =
      status === "REJECTED"
        ? new Date(Date.now() + SHADOW_TRACKING_DAYS * 24 * 3_600_000)
        : null;
    const rejectionReason =
      input.screening.rejectedBy.length > 0 ? input.screening.rejectedBy.join(", ") : null;

    const dedupeSince = new Date(Date.now() - DEDUPE_WINDOW_HOURS * 3_600_000);
    const existing = await this.prisma.poolCandidate.findFirst({
      where: {
        poolAddress: input.poolAddress,
        preset: presetToDb(input.preset),
        status: { in: ["DISCOVERED", "REJECTED"] },
        discoveredAt: { gte: dedupeSince },
      },
      orderBy: { discoveredAt: "desc" },
      select: { id: true },
    });

    const data = {
      status,
      score: input.screening.score.total,
      rawMetrics: asJson(input.pool),
      filterResult: asJson(input.screening),
      rejectionReason,
      shadowUntil,
    } satisfies Prisma.PoolCandidateUncheckedUpdateInput;

    let candidateId: string;
    let created: boolean;
    if (existing !== null) {
      await this.prisma.poolCandidate.update({ where: { id: existing.id }, data });
      candidateId = existing.id;
      created = false;
    } else {
      const row = await this.prisma.poolCandidate.create({
        data: {
          poolAddress: input.poolAddress,
          source: sourceToDb(input.source),
          preset: presetToDb(input.preset),
          ...data,
        },
        select: { id: true },
      });
      candidateId = row.id;
      created = true;
    }

    await this.prisma.poolSnapshot.create({
      data: {
        poolAddress: input.poolAddress,
        tvlUsd: input.pool.tvlUsd ?? null,
        volume24hUsd: input.pool.volume24hUsd ?? null,
        fees24hUsd: input.pool.fees24hUsd ?? null,
        feeTvl24hPct: input.pool.feeTvl24hPct ?? null,
        priceNative: input.pool.priceNative ?? null,
        binStep: input.pool.binStep,
      },
    });

    return { candidateId, created };
  }

  /** Kandidaten, deren Shadow-Tracking noch läuft (für spätere Auswertung). */
  async listShadowed(now: Date = new Date()) {
    return this.prisma.poolCandidate.findMany({
      where: { status: "REJECTED", shadowUntil: { gte: now } },
      orderBy: { discoveredAt: "desc" },
    });
  }
}

function presetToDb(preset: PresetKind): "DEGEN" | "MULTIDAY" {
  return preset === "degen" ? "DEGEN" : "MULTIDAY";
}

function sourceToDb(
  source: CandidateSource,
): "FABRIQ_DEGEN" | "FABRIQ_MULTIDAY" | "REPLICATED_DEGEN" | "REPLICATED_MULTIDAY" {
  switch (source) {
    case "fabriq_degen":
      return "FABRIQ_DEGEN";
    case "fabriq_multiday":
      return "FABRIQ_MULTIDAY";
    case "replicated_degen":
      return "REPLICATED_DEGEN";
    case "replicated_multiday":
      return "REPLICATED_MULTIDAY";
  }
}

function asJson(value: unknown): Prisma.InputJsonValue {
  // Date-Objekte etc. in JSON-kompatible Werte überführen.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
