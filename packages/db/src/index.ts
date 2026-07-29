import { PrismaClient } from "@prisma/client";

export { PrismaConfigStore } from "./configStore";
export { ScanRepo } from "./scanRepo";
export type { RecordedCandidate, ScanRecordInput } from "./scanRepo";
export { PrismaClient };

/**
 * Erzeugt den Prisma-Client. DATABASE_URL kommt aus der Umgebung;
 * ein expliziter Override ist für Tests/Tools möglich.
 */
export function createPrisma(datasourceUrl?: string): PrismaClient {
  return datasourceUrl !== undefined
    ? new PrismaClient({ datasourceUrl })
    : new PrismaClient();
}
