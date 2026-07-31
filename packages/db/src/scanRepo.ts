import type { Prisma, PrismaClient } from "@prisma/client";
import type { CandidateSource, PoolMetrics, PresetKind, ScreeningResult } from "@lping/core";
import { snapshotDataOf } from "./trackRepo";

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
        preset: input.preset,
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
          source: input.source === "fabriq" ? "FABRIQ" : "REPLICATED",
          preset: input.preset,
          ...data,
        },
        select: { id: true },
      });
      candidateId = row.id;
      created = true;
    }

    // Vollständig wie die Aufzeichnung, nicht abgespeckt: Die Zeile landet in
    // derselben Tabelle und wird vom Replay genauso gelesen. Eine Zeile ohne
    // SOL-Kurs oder Gebührenstruktur sieht dort aus wie ein Messpunkt, liefert
    // aber keinen Gebührenanteil — der Fehler fällt erst in den Ergebnissen auf.
    await this.prisma.poolSnapshot.create({ data: snapshotDataOf(input.pool) });

    return { candidateId, created };
  }

  /**
   * Hält das Regime-Urteil eines Durchgangs fest.
   *
   * Geschrieben wird **immer**, auch wenn das Tor nicht blockiert hat. Nur so
   * entsteht die Reihe, an der sich später prüfen lässt, ob „ungünstig"
   * tatsächlich schlechtere Ergebnisse vorhersagt — und damit, ob das Tor
   * seine Berechtigung hat oder nur Einstiege kostet.
   */
  async recordRegime(input: {
    status: string;
    medianYieldPerVariance: number | null;
    sampled: number;
    skipped: number;
    blockedOpening: boolean;
    at?: Date;
  }): Promise<void> {
    await this.prisma.regimeSnapshot.create({
      data: {
        ...(input.at !== undefined ? { ts: input.at } : {}),
        status: input.status,
        medianYieldPerVariance: input.medianYieldPerVariance,
        sampled: input.sampled,
        skipped: input.skipped,
        blockedOpening: input.blockedOpening,
      },
    });
  }

  /**
   * Verteilung der Regime-Urteile über einen Zeitraum.
   *
   * Die Grundlage der Kalibrierung: Wie oft war das Regime ungünstig, und wie
   * oft hat das tatsächlich einen Einstieg verhindert?
   */
  async regimeHistory(since: Date): Promise<
    { status: string; count: number; blocked: number }[]
  > {
    const rows = await this.prisma.regimeSnapshot.groupBy({
      by: ["status"],
      where: { ts: { gte: since } },
      _count: { _all: true },
    });
    const blocked = await this.prisma.regimeSnapshot.groupBy({
      by: ["status"],
      where: { ts: { gte: since }, blockedOpening: true },
      _count: { _all: true },
    });
    const blockedByStatus = new Map(blocked.map((row) => [row.status, row._count._all]));
    return rows.map((row) => ({
      status: row.status,
      count: row._count._all,
      blocked: blockedByStatus.get(row.status) ?? 0,
    }));
  }

  /** Kandidaten, deren Shadow-Tracking noch läuft (für spätere Auswertung). */
  async listShadowed(now: Date = new Date()) {
    return this.prisma.poolCandidate.findMany({
      where: { status: "REJECTED", shadowUntil: { gte: now } },
      orderBy: { discoveredAt: "desc" },
    });
  }
}

function asJson(value: unknown): Prisma.InputJsonValue {
  // Date-Objekte etc. in JSON-kompatible Werte überführen.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
