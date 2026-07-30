import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import {
  ConfigService,
  FEATURE_VERSION,
  buildFeatureVector,
  effectiveFeePct,
  parseBotConfig,
  type PoolMetrics,
  type ScreeningResult,
} from "@lping/core";
import { PrismaConfigStore, ScanRepo, TrackRepo, createPrisma } from "../src/index";

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
/** Zweiter Testpool: angemeldet, aber ohne einen einzigen Messpunkt. */
const EMPTY_POOL = `${TEST_PREFIX}Empty${Date.now()}`;
const TEST_MINT = "TestMint1111111111111111111111111111111111";

function testPool(): PoolMetrics {
  return {
    poolAddress: TEST_POOL,
    name: "TEST-SOL",
    mintX: "TestMint1111111111111111111111111111111111",
    mintY: "So11111111111111111111111111111111111111112",
    binStep: 100,
    tvlUsd: 123_456,
    // Gebührenstruktur: dynamisch > base, Protokoll nimmt 10 % der Gebühr.
    baseFeePct: 1,
    dynamicFeePct: 1.4,
    maxFeePct: 10,
    protocolFeePct: 10,
    collectFeeMode: "only_y",
    tokenX: { mint: "TestMint1111111111111111111111111111111111", priceUsd: 0.18 },
    tokenY: { mint: "So11111111111111111111111111111111111111112", priceUsd: 180 },
    volumeUsd: { h1: 21_000, h24: 500_000 },
    feesUsd: { h1: 210, h24: 5_000 },
    feeTvlPct: { h1: 0.17, h24: 4.05 },
    protocolFeesUsd: { h24: 500 },
    volume24hUsd: 500_000,
    fees24hUsd: 5_000,
    feeTvl24hPct: 4.05,
    priceNative: 0.001,
    rewardMints: [],
    tags: [],
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
    // Versionsnummern sind fortlaufende Kennungen, keine lückenlose Folge:
    // gelöschte Versionen (etwa die dieses Selbsttests) hinterlassen Lücken.
    assert(service.version > startVersion, "Update erzeugt eine neue, höhere Version");
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

    console.log("Aufzeichnung für die Optimierung:");
    const track = new TrackRepo(prisma);
    const decisionAt = new Date(Date.now() - 30 * 3_600_000);

    const featureId = await track.recordFeatures({
      poolAddress: TEST_POOL,
      tokenMint: "TestMint1111111111111111111111111111111111",
      preset: "degen",
      featureVersion: FEATURE_VERSION,
      features: buildFeatureVector({
        pool: testPool(),
        market: null,
        risk: null,
        sellability: null,
        organics: null,
        priceDivergencePct: null,
      }),
      score: 71.5,
      verdict: "rejected",
      rejectedBy: ["token_age"],
      capturedAt: decisionAt,
    });
    assert(featureId.length > 0, "Merkmalsvektor gespeichert");

    await track.trackPool(TEST_POOL, "TestMint1111111111111111111111111111111111", decisionAt);
    const due = await track.duePools();
    assert(
      due.some((p) => p.poolAddress === TEST_POOL),
      "Neu angemeldeter Pool ist sofort fällig",
    );

    // Verlauf simulieren: Preis fällt über 26 Stunden um 20 %.
    // Geschrieben über recordPoint, nicht direkt — nur so wird der Pfad geprüft,
    // den die Aufzeichnung wirklich benutzt (inkl. Gebühren und Zeitfenster).
    for (const hours of [0, 1, 6, 24, 26]) {
      const factor = 1 - 0.2 * (hours / 26);
      await track.recordPoint(
        { ...testPool(), priceNative: 0.001 * factor },
        new Date(decisionAt.getTime() + hours * 3_600_000),
      );
    }

    // Gebührenstruktur und Zeitfenster müssen den Weg durch Postgres überleben:
    // sie sind die Grundlage des Replays (KONZEPT-ML.md 5).
    const points = await track.loadTrack(TEST_POOL, decisionAt);
    // Gezählt werden die Messpunkte der Aufzeichnung, nicht alle Zeilen: Der
    // Scan schreibt in dieselbe Tabelle, aber ohne Gebührenstruktur, SOL-Kurs
    // und Zeitfenster. Beide Schreiber zu haben ist ein bekannter Mangel — die
    // Zusicherung darf davon nur nicht abhängen.
    const recorded = points.filter((p) => p.dynamicFeePct !== null);
    assert(
      recorded.length === 5,
      `Zeitreihe über loadTrack gelesen (${recorded.length} Messpunkte von ${points.length} Zeilen)`,
    );
    const firstPoint = points[0];
    assert(
      firstPoint !== undefined && firstPoint.dynamicFeePct !== null,
      "Dynamische Gebühr je Messpunkt gespeichert",
    );
    assert(
      firstPoint !== undefined && firstPoint.protocolFeePct !== null,
      "Protokollanteil je Messpunkt gespeichert",
    );
    assert(
      firstPoint?.windows?.volume?.h1 === 21_000,
      `Zeitfenster als JSON erhalten (h1=${firstPoint?.windows?.volume?.h1})`,
    );
    assert(
      firstPoint?.solPriceUsd === 180,
      `SOL-Preis je Messpunkt gespeichert (${firstPoint?.solPriceUsd})`,
    );
    // Der Replay leitet daraus den Satz ab, mit dem er Gebühren buchet.
    assert(
      firstPoint !== undefined && effectiveFeePct(firstPoint) === 1.4,
      `Effektive Gebührenrate bestimmbar (${firstPoint && effectiveFeePct(firstPoint)})`,
    );

    const written = await track.computeDueOutcomes();
    assert(written > 0, `Ergebnis-Labels berechnet (${written})`);

    const outcomes = await prisma.candidateOutcome.findMany({
      where: { featureId },
      orderBy: { horizonHours: "asc" },
    });
    assert(outcomes.length >= 3, `Labels für mehrere Horizonte (${outcomes.length})`);

    const h24 = outcomes.find((o) => o.horizonHours === 24);
    assert(h24 !== undefined, "24-Stunden-Label vorhanden");
    assert(
      h24 !== undefined && Number(h24.priceChangePct) < -15,
      "Preisrückgang korrekt gemessen",
    );

    // Ein Horizont, der noch nicht verstrichen ist, darf kein Label bekommen —
    // sonst wären die Labels systematisch verzerrt.
    assert(
      !outcomes.some((o) => o.horizonHours === 168),
      "Noch nicht verstrichener Horizont bleibt offen",
    );

    const dataset = await track.exportDataset(24, { minCoverageRatio: 0.1 });
    assert(
      dataset.some((row) => row.features["bin_step"] === 100),
      "Datensatz-Export liefert Merkmale samt Label",
    );
    assert(
      dataset.every((row) => row.outcome.observations > 0 && row.outcome.coveredHours > 0),
      "Labels tragen ihre Qualitätsangaben mit",
    );

    // Der Verlauf deckt 26 von 168 Stunden ab: Für den 7-Tage-Horizont ist das
    // zu wenig, und genau das muss der Export erkennen — sonst trainiert man
    // später auf Labels, die eine Aufzeichnungslücke sind.
    const strict = await track.exportDataset(24, { minCoverageRatio: 0.95 });
    assert(strict.length <= dataset.length, "Strengere Abdeckungsforderung filtert stärker");

    const quality = await track.datasetQuality([1, 24, 168]);
    const weekly = quality.find((q) => q.horizonHours === 168);
    assert(
      weekly !== undefined && weekly.usable === 0,
      "Lückenhaft belegte Horizonte gelten als unbrauchbar",
    );

    await checkOutcomeBacklog(prisma, track, decisionAt);

    const stats = await track.stats();
    assert(stats.features >= 1 && stats.outcomes >= 3, "Statistik zählt Merkmale und Labels");
    // Die Rohabfrage COUNT(DISTINCT (a,b)) ist die einzige Stelle mit
    // handgeschriebenem SQL — sie wird hier gegen echtes Postgres geprüft.
    assert(
      stats.distinctCandidates >= 1 && stats.distinctCandidates <= stats.features,
      `Verschiedene Kandidaten gezählt (${stats.distinctCandidates} von ${stats.features} Zeilen)`,
    );
    assert(
      stats.distinctPools >= 1 && stats.distinctPools <= stats.distinctCandidates,
      `Verschiedene Pools gezählt (${stats.distinctPools})`,
    );

    console.log("\nDB-Roundtrip OK ✔");
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect();
  }
}

/**
 * Nachberechnung der Ergebnis-Labels: Der Stapel muss vorankommen.
 *
 * Der Fehler, den dieser Abschnitt ausschließt: Wählt die Nachberechnung die
 * ältesten Kandidaten aus, ohne zu prüfen, ob sie überhaupt noch offene Labels
 * haben, belegen die fertigen den Stapel dauerhaft. Ab dem ersten vollen Stapel
 * bekommt kein neuer Kandidat mehr ein Label — lautlos, denn die Gesamtzahl der
 * Labels bleibt dabei hoch und sieht gesund aus. Deshalb läuft dieser Test
 * bewusst mit Stapelgröße 1: Er bildet in klein nach, was im Betrieb ab ein paar
 * hundert Kandidaten passiert.
 */
async function checkOutcomeBacklog(
  prisma: ReturnType<typeof createPrisma>,
  track: TrackRepo,
  decisionAt: Date,
): Promise<void> {
  console.log("\nNachberechnung der Ergebnis-Labels:");

  const recordFeature = (poolAddress: string, offsetMin: number): Promise<string> =>
    track.recordFeatures({
      poolAddress,
      tokenMint: TEST_MINT,
      preset: "degen",
      featureVersion: FEATURE_VERSION,
      features: buildFeatureVector({
        pool: { ...testPool(), poolAddress },
        market: null,
        risk: null,
        sellability: null,
        organics: null,
        priceDivergencePct: null,
      }),
      score: 70,
      verdict: "accepted",
      rejectedBy: [],
      capturedAt: new Date(decisionAt.getTime() + offsetMin * 60_000),
    });

  // Zwei weitere Kandidaten auf dem bereits verfolgten Pool. Der Kandidat aus
  // dem Hauptlauf ist für seine fälligen Horizonte fertig — genau der, der den
  // Stapel früher dauerhaft besetzt hätte.
  const older = await recordFeature(TEST_POOL, 6);
  const newer = await recordFeature(TEST_POOL, 12);

  const overdueBefore = await track.overdueOutcomes();
  assert(overdueBefore >= 4, `Offene Labels gelten als überfällig (${overdueBefore})`);

  const first = await track.computeDueOutcomes(new Date(), 1);
  const second = await track.computeDueOutcomes(new Date(), 1);
  assert(
    first > 0 && second > 0,
    `Beide Durchgänge schreiben Labels (${first}, dann ${second})`,
  );

  const olderCount = await prisma.candidateOutcome.count({ where: { featureId: older } });
  const newerCount = await prisma.candidateOutcome.count({ where: { featureId: newer } });
  assert(olderCount >= 3, `Erster Kandidat abgearbeitet (${olderCount} Labels)`);
  assert(
    newerCount >= 3,
    `Zweiter Kandidat ebenfalls — der Stapel bleibt nicht stehen (${newerCount} Labels)`,
  );

  const overdueAfter = await track.overdueOutcomes();
  assert(
    overdueAfter < overdueBefore,
    `Rückstand sinkt mit der Nachberechnung (${overdueBefore} → ${overdueAfter})`,
  );

  // Ein Kandidat, dessen Pool nie gemessen wurde, darf den Stapel ebenfalls
  // nicht dauerhaft blockieren. Er bekommt leere Labels und ist damit erledigt.
  await track.trackPool(EMPTY_POOL, TEST_MINT, decisionAt);
  const orphan = await recordFeature(EMPTY_POOL, 18);
  const written = await track.computeDueOutcomes(new Date(), 5);
  assert(written > 0, `Kandidat ohne Messpunkte wird abgeschlossen (${written} Labels)`);

  const orphanOutcomes = await prisma.candidateOutcome.findMany({
    where: { featureId: orphan },
  });
  assert(
    orphanOutcomes.length >= 3 && orphanOutcomes.every((o) => o.observations === 0),
    `Leere Labels weisen ihre Leere aus (${orphanOutcomes.length})`,
  );
  // Und sie bleiben harmlos: Der Export siebt sie über die Qualitätsangaben aus.
  const dataset = await track.exportDataset(24, { minCoverageRatio: 0.1 });
  assert(
    dataset.every((row) => row.outcome.observations >= 2),
    "Leere Labels landen nicht im Trainingsdatensatz",
  );
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
    // Outcomes hängen per Cascade an den Features.
    await client.candidateFeature.deleteMany({ where: { poolAddress: { startsWith: TEST_PREFIX } } });
    await client.trackedPool.deleteMany({ where: { poolAddress: { startsWith: TEST_PREFIX } } });
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
