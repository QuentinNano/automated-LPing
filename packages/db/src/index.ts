import { PrismaClient } from "@prisma/client";

export { PrismaConfigStore } from "./configStore";
export { ScanRepo } from "./scanRepo";
export type { RecordedCandidate, ScanRecordInput } from "./scanRepo";
export { TrackRepo, snapshotDataOf, trailingDailyRate } from "./trackRepo";
export type { RecordFeatureInput, DuePool, DatasetRow, ReplayPoolRow } from "./trackRepo";
export { PaperRepo } from "./paperRepo";
export type {
  OpenPaperPositionRecord,
  TickPaperPositionRecord,
  ClosePaperPositionRecord,
  OpenPaperPosition,
} from "./paperRepo";
export { PrismaClient };

/**
 * Erzeugt den Prisma-Client. DATABASE_URL kommt aus der Umgebung;
 * ein expliziter Override ist für Tests/Tools möglich.
 *
 * Prüft zugleich, ob der erzeugte Client zum aktuellen Schema passt. Ohne diese
 * Prüfung äußert sich ein veralteter Client erst tief im Programmablauf als
 * "Cannot read properties of undefined" — eine Meldung, aus der niemand die
 * eigentliche Ursache ableiten kann.
 */
export function createPrisma(datasourceUrl?: string): PrismaClient {
  const client =
    datasourceUrl !== undefined ? new PrismaClient({ datasourceUrl }) : new PrismaClient();

  const required = ["trackedPool", "candidateFeature", "candidateOutcome", "position"] as const;
  const missing = required.filter((model) => (client as unknown as Record<string, unknown>)[model] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Der Datenbank-Zugriffscode ist veraltet (fehlend: ${missing.join(", ")}).\n` +
        `Bitte einmal ausführen:\n  pnpm db:generate\n`,
    );
  }
  return client;
}
