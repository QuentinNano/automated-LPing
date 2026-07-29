import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import {
  ConfigService,
  parseBotConfig,
  type PoolMetrics,
  type ScreeningResult,
} from "@lping/core";
import { PrismaConfigStore, ScanRepo, createPrisma } from "../src/index";

/**
 * DB-Roundtrip-Check gegen die per DATABASE_URL konfigurierte Datenbank:
 * verifiziert Migrationen, Config-Versionierung und Kandidaten-Persistenz
 * inkl. Dedupe und Shadow-Tracking. Idempotent genug für Wiederholungen
 * (eigener Test-Pool-Prefix), aber gedacht für eine frische Dev-DB.
 *
 * Aufruf: pnpm --filter @lping/db db:check
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Wie bei Bot und Web: die .env liegt im Projektwurzelverzeichnis, das Skript
// startet aber aus packages/db.
loadEnv({ path: path.join(repoRoot, ".env") });

function loadDefaults(): unknown {
  const configDir = path.join(repoRoot, "config");
  const read = (name: string) =>
    JSON.parse(readFileSync(path.join(configDir, name), "utf8")) as unknown;

  const presets: Record<string, unknown> = {};
  for (const file of readdirSync(configDir).sort()) {
    if (file === "global.json" || !file.endsWith(".json")) continue;
    presets[path.basename(file, ".json")] = read(file);
  }
  return { global: read("global.json"), presets };
}

function assert(condition: boolean, label: string): void {
  if (!condition) throw new Error(`FEHLGESCHLAGEN: ${label}`);
  console.log(`  ✓ ${label}`);
}

/** Erkennungszeichen der Testdaten — danach wird am Ende aufgeräumt. */
const TEST_PREFIX = "RoundtripTestPool";
const TEST_POOL = `${TEST_PREFIX}${Date.now()}`;

function testPool(): PoolMetrics {
  return {
    poolAddress: TEST_POOL,
    name: "TEST-SOL",
    mintX: "TestMint1111111111111111111111111111111111",
    mintY: "So11111111111111111111111111111111111111112",
    binStep: 100,
    tvlUsd: 123_456,
    volume24hUsd: 500_000,
    fees24hUsd: 5_000,
    feeTvl24hPct: 4.05,
    priceNative: 0.001,
    fetchedAt: new Date(),
    source: "meteora",
  };
}

function testScreening(verdict: "accepted" | "rejected"): ScreeningResult {
  return {
    verdict,
    checks: [{ id: "min_tvl", status: "passed", value: 123_456, limit: 50_000 }],
    rejectedBy: verdict === "rejected" ? ["token_age"] : [],
    score: {
      total: 71.5,
      components: [{ id: "fee_yield", points: 35, max: 35 }],
    },
    screenedAt: new Date(),
  };
}

async function main(): Promise<void> {
  const prisma = createPrisma();
  try {
    console.log("Config-Versionierung:");
    const service = await ConfigService.init(new PrismaConfigStore(prisma), loadDefaults());
    const startVersion = service.version;
    assert(startVersion >= 1, `ConfigService initialisiert (Version ${startVersion})`);
    await service.update(
      { global: { profitSweepThresholdSol: 4 } },
      { actor: "db:check", reason: "roundtrip" },
    );
    assert(service.version === startVersion + 1, "Update erzeugt neue Version");
    assert(
      service.config.global.profitSweepThresholdSol === 4,
      "Patch angekommen (profitSweepThresholdSol=4)",
    );

    console.log("Kandidaten-Persistenz:");
    const repo = new ScanRepo(prisma);
    const first = await repo.recordScreened({
      poolAddress: TEST_POOL,
      preset: "degen",
      source: "replicated",
      pool: testPool(),
      screening: testScreening("accepted"),
    });
    assert(first.created, "Erster Scan legt Kandidaten an");

    const second = await repo.recordScreened({
      poolAddress: TEST_POOL,
      preset: "degen",
      source: "replicated",
      pool: testPool(),
      screening: testScreening("rejected"),
    });
    assert(!second.created, "Zweiter Scan dedupliziert (Update statt Insert)");
    assert(second.candidateId === first.candidateId, "Gleiche Kandidaten-ID");

    const candidate = await prisma.poolCandidate.findUniqueOrThrow({
      where: { id: first.candidateId },
    });
    assert(candidate.status === "REJECTED", "Status auf REJECTED aktualisiert");
    assert(candidate.shadowUntil !== null, "Shadow-Tracking-Frist gesetzt");
    assert(candidate.rejectionReason === "token_age", "Ablehnungsgrund gespeichert");
    assert(Number(candidate.score) === 71.5, "Score gespeichert");

    const snapshots = await prisma.poolSnapshot.count({ where: { poolAddress: TEST_POOL } });
    assert(snapshots === 2, "Je Scan ein Pool-Snapshot (Zeitreihe)");

    const shadowed = await repo.listShadowed();
    assert(
      shadowed.some((c) => c.id === first.candidateId),
      "Kandidat erscheint in der Shadow-Liste",
    );

    console.log("\nDB-Roundtrip OK ✔");
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect();
  }
}

/**
 * Entfernt alle Spuren des Selbsttests.
 *
 * Der Test schreibt bewusst in die echte Datenbank — nur so beweist er, dass
 * Schreiben, Deduplizieren und Shadow-Tracking wirklich funktionieren. Ohne
 * Aufräumen tauchten die Testdaten aber im Scanner der Oberfläche auf, als
 * wären es entdeckte Pools. Läuft in `finally`, damit auch ein abgebrochener
 * Lauf nichts zurücklässt.
 */
async function cleanup(client: ReturnType<typeof createPrisma>): Promise<void> {
  try {
    await client.poolSnapshot.deleteMany({ where: { poolAddress: { startsWith: TEST_PREFIX } } });
    await client.poolCandidate.deleteMany({ where: { poolAddress: { startsWith: TEST_PREFIX } } });
    // Die vom Test erzeugte Config-Version zurücknehmen, damit die Historie
    // in der Oberfläche nur echte Änderungen zeigt.
    await client.configVersion.deleteMany({ where: { actor: "db:check" } });
  } catch (error) {
    console.warn(
      `Hinweis: Testdaten konnten nicht vollständig entfernt werden (${
        error instanceof Error ? error.message : String(error)
      }).`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
