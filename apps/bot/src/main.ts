import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { ConfigValidationError, type AdapterHealth, type BotConfig } from "@lping/core";
import {
  AdapterError,
  DexScreenerAdapter,
  FabriqAdapter,
  JupiterAdapter,
  JupiterTokenAdapter,
  MeteoraAdapter,
  RugcheckAdapter,
  WSOL_MINT,
  sleep,
} from "@lping/adapters";
import { loadDefaultsFromDir } from "./loadConfig";
import { cmdFabriqCheck } from "./fabriqCheck";
import { cmdApiCheck } from "./apiCheck";
import {
  DEFAULT_CYCLE_LIMIT,
  formatFeatureVersions,
  formatHealthReport,
  formatTrackStatus,
  runTrackCycle,
  type TrackDeps,
} from "./track";
import {
  formatHistoryStats,
  parseTimeframe,
  runBackfill,
  type BackfillDeps,
} from "./backfill";
import { formatScanTable, runScan, type ScanDeps } from "./scan";
import {
  formatComparison,
  openFromScan,
  presetLabels,
  tickOpenPositions,
  type PaperDeps,
  type PaperStore,
} from "./paper";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configDir = path.join(repoRoot, "config");

// Die .env liegt im Projektwurzelverzeichnis, der Bot startet aber aus
// apps/bot — ohne expliziten Pfad würde dotenv sie nicht finden.
loadEnv({ path: path.join(repoRoot, ".env") });

async function main(): Promise<number> {
  const command = process.argv[2] ?? "validate";
  switch (command) {
    case "validate":
      return cmdValidate();
    case "health":
      return cmdHealth();
    case "api:check":
      return cmdApiCheck();
    case "fabriq:check":
      return cmdFabriqCheck(process.argv[3]);
    case "scan":
      return cmdScan(process.argv.slice(3));
    case "paper":
      return cmdPaper(process.argv.slice(3));
    case "track":
      return cmdTrack(process.argv.slice(3));
    case "backfill":
      return cmdBackfill(process.argv.slice(3));
    default:
      console.error(
        `Unbekanntes Kommando: ${command}\n` +
          `Verfügbar: validate | health | scan | paper | track | backfill | api:check | fabriq:check <URL>`,
      );
      return 2;
  }
}

function cmdValidate(): number {
  let config: BotConfig;
  try {
    config = loadDefaultsFromDir(configDir);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  console.log("Konfiguration OK ✔\n");
  console.log(`  paperTrading:        ${config.global.paperTrading ? "AN (sicher)" : "AUS — LIVE!"}`);
  console.log(`  killSwitch:          ${config.global.killSwitch}`);
  console.log(`  maxTotalExposureSol: ${config.global.maxTotalExposureSol}`);
  console.log(`  Verlustlimits:       ${config.global.dailyLossLimitPct}% Tag / ${config.global.hardLossLimitPct}% hart`);
  console.log(`  Paper-Kapital:       ${config.global.paper.capitalPerPresetSol} SOL je Preset\n`);
  for (const [id, preset] of Object.entries(config.presets)) {
    console.log(
      `  ${id.padEnd(12)}: ${preset.enabled ? "aktiv" : "aus  "}, ` +
        `${String(preset.capitalSharePct).padStart(3)}% Kapital, max ${preset.maxPositions} Positionen, ` +
        `${preset.strategy.type}/${preset.strategy.sided}, SL ${preset.stopLossPct}%, ` +
        `Halten max ${preset.maxHoldHours}h`,
    );
  }
  if (!config.global.paperTrading) {
    console.warn("\n⚠ paperTrading ist deaktiviert — dieser Stand darf noch nicht live handeln (Phase 1)!");
  }
  return 0;
}

async function cmdHealth(): Promise<number> {
  const validation = cmdValidate();
  if (validation !== 0) return validation;

  console.log("\nAdapter-Health-Checks (Netzwerk erforderlich):\n");
  const adapters = [
    new MeteoraAdapter(),
    new DexScreenerAdapter(),
    new RugcheckAdapter(),
    new JupiterAdapter(),
    new FabriqAdapter(),
  ];
  const results = await Promise.all(adapters.map((adapter) => adapter.health()));

  for (const result of results) {
    printHealth(result);
  }
  return results.every((r) => r.ok || r.adapter === "fabriq") ? 0 : 1;
}

async function cmdScan(args: string[]): Promise<number> {
  let config: BotConfig;
  try {
    config = loadDefaultsFromDir(configDir);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  // --pages zählt Seiten **je Sortierung**; der Default steckt in discoverPools,
  // damit CLI und Bibliothek nicht auseinanderlaufen.
  const pages = intFlag(args, "--pages");
  const top = intFlag(args, "--top") ?? 12;
  const noDb = args.includes("--no-db");

  // Persistenz ist optional: ohne DB läuft der Scan, nur ohne Shadow-Tracking.
  let persist: ScanDeps["persist"] = null;
  let track: ScanDeps["track"] = null;
  if (!noDb && process.env["DATABASE_URL"] !== undefined && process.env["DATABASE_URL"] !== "") {
    try {
      const { createPrisma, ScanRepo, TrackRepo } = await import("@lping/db");
      const prisma = createPrisma();
      persist = new ScanRepo(prisma);
      track = new TrackRepo(prisma);
    } catch (error) {
      console.warn(
        `DB-Persistenz nicht verfügbar (${error instanceof Error ? error.message : String(error)}) — ` +
          `Scan läuft ohne Shadow-Tracking. Setup: docker compose up -d && pnpm db:generate && pnpm db:migrate`,
      );
    }
  } else if (!noDb) {
    console.warn("DATABASE_URL nicht gesetzt — Scan läuft ohne Persistenz/Shadow-Tracking.");
  }

  const deps: ScanDeps = {
    meteora: new MeteoraAdapter(),
    dexscreener: new DexScreenerAdapter(),
    rugcheck: new RugcheckAdapter(),
    jupiter: new JupiterAdapter(),
    jupiterTokens: new JupiterTokenAdapter(),
    persist,
    track,
    log: (line) => console.log(`  ${line}`),
  };

  console.log(
    `Scan gestartet (${pages ?? "Standard"} Seite(n) je Sortierung, top=${top} je Preset)…\n`,
  );
  const summary = await runScan(deps, config, {
    topPerPreset: top,
    ...(pages !== undefined ? { pages } : {}),
  });
  console.log("\n" + formatScanTable(summary));
  return 0;
}

/**
 * Paper-Trading: alle aktiven Presets laufen gleichzeitig auf denselben
 * Marktdaten. Ein Zyklus = offene Positionen aktualisieren, danach optional
 * neue Kandidaten aus einem frischen Scan eröffnen.
 */
async function cmdPaper(args: string[]): Promise<number> {
  let config: BotConfig;
  try {
    config = loadDefaultsFromDir(configDir);
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(
      "paper benötigt eine Datenbank (Positionen müssen Neustarts überleben).\n" +
        "Setup: docker compose up -d && pnpm db:generate && pnpm db:migrate,\n" +
        "danach DATABASE_URL in .env eintragen.",
    );
    return 1;
  }

  let store: PaperStore;
  try {
    const { createPrisma, PaperRepo } = await import("@lping/db");
    store = new PaperRepo(createPrisma());
  } catch (error) {
    console.error(`Datenbank nicht verfügbar: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const intervalMin = intFlag(args, "--interval") ?? 0;
  const pages = intFlag(args, "--pages");
  const top = intFlag(args, "--top") ?? 8;
  const tickOnly = args.includes("--tick-only");

  const meteora = new MeteoraAdapter();
  const dexscreener = new DexScreenerAdapter();
  const jupiter = new JupiterAdapter();
  const labels = presetLabels(config);

  const paperDeps: PaperDeps = {
    store,
    getPool: (address) => meteora.getPair(address),
    getSolPriceUsd: async () => {
      // SOL/USDC-Referenz über DexScreener; nur zur Umrechnung von TVL/Volumen.
      const { pairs } = await dexscreener.getPairsForToken(WSOL_MINT);
      const withPrice = pairs.find((p) => p.priceUsd !== undefined && p.priceUsd > 0);
      if (withPrice?.priceUsd === undefined) throw new Error("SOL-Preis nicht ermittelbar");
      return withPrice.priceUsd;
    },
    log: (line) => console.log(`  ${line}`),
  };

  const runCycle = async (): Promise<void> => {
    console.log(`\n=== Zyklus ${new Date().toISOString()} ===`);

    console.log("Offene Positionen aktualisieren…");
    const ticked = await tickOpenPositions(paperDeps, config);
    console.log(`  ${ticked.ticked} aktualisiert, ${ticked.closed} geschlossen`);
    for (const note of ticked.notes) console.log(`  ! ${note}`);

    if (!tickOnly) {
      console.log("Neue Kandidaten suchen…");
      const db = await import("@lping/db");
      const prisma = db.createPrisma();
      const summary = await runScan(
        {
          meteora,
          dexscreener,
          rugcheck: new RugcheckAdapter(),
          jupiter,
          jupiterTokens: new JupiterTokenAdapter(),
          persist: new db.ScanRepo(prisma),
          // Auch der Paper-Betrieb speist den Datensatz für die spätere
          // Optimierung — sonst sammelt nur ein separat gestarteter Scan.
          track: new db.TrackRepo(prisma),
          log: () => {},
        },
        config,
        { topPerPreset: top, ...(pages !== undefined ? { pages } : {}) },
      );
      console.log(`  ${summary.accepted} akzeptiert von ${summary.rows.length} geprüften`);
      const opened = await openFromScan(paperDeps, config, summary.rows);
      console.log(`  ${opened.opened} Positionen eröffnet`);
      for (const note of opened.notes) console.log(`  ! ${note}`);
    }

    console.log("\n" + formatComparison(await store.performance(labels)));
  };

  try {
    await runCycle();
  } catch (error) {
    console.error("\n" + explainFailure(error));
    // Im Dauerbetrieb ist ein gescheiterter Zyklus kein Grund aufzuhören —
    // API-Ausfälle sind vorübergehend.
    if (intervalMin === 0) return 1;
  }

  if (intervalMin > 0) {
    console.log(`\nLaufender Betrieb: nächster Zyklus in ${intervalMin} min (Abbruch mit Strg+C).`);
    // Kein setInterval: der nächste Zyklus startet erst, wenn der vorige fertig
    // ist — sonst überlappen sich API-Aufrufe bei langsamen Antworten.
    for (;;) {
      await sleep(intervalMin * 60_000);
      try {
        await runCycle();
      } catch (error) {
        console.error("\n" + explainFailure(error));
      }
    }
  }

  return 0;
}

/**
 * Datenaufzeichnung für die Strategie-Optimierung (KONZEPT-ML.md M1).
 *
 * Der Zyklus besteht aus zwei Teilen, die beide nötig sind: Ein Scan **entdeckt**
 * neue Pools und hält ihre Merkmale fest, das Tracking **verfolgt** deren
 * weiteren Verlauf. Ohne den Scan hätte das Tracking nichts aufzuzeichnen —
 * deshalb erledigt dieses Kommando beides, statt einen zweiten Dauerlauf zu
 * verlangen.
 *
 * Der Scan läuft seltener als das Tracking (`--scan-every`), weil er die teuren
 * Per-Token-Abrufe auslöst, während ein Messpunkt nur eine Pool-Abfrage kostet.
 */
async function cmdTrack(args: string[]): Promise<number> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(
      "track benötigt eine Datenbank.\n" +
        "Setup: docker compose up -d && pnpm db:generate && pnpm db:migrate",
    );
    return 1;
  }

  const db = await import("@lping/db");
  const prisma = db.createPrisma();
  const store = new db.TrackRepo(prisma);
  const meteora = new MeteoraAdapter();

  const statusOnly = args.includes("--status");
  const intervalMin = intFlag(args, "--interval") ?? 0;
  const limit = intFlag(args, "--limit") ?? DEFAULT_CYCLE_LIMIT;
  const scanEvery = args.includes("--no-scan") ? 0 : (intFlag(args, "--scan-every") ?? 6);
  // Nachladen schließt Lücken und gibt neu entdeckten Pools ihre Vorgeschichte.
  // Es gehört in den Dauerbetrieb, nicht in die Handarbeit: Wer eine Nacht
  // Unterbrechung erst Tage später bemerkt, hat sie bis dahin im Datensatz.
  const backfillEvery = args.includes("--no-backfill")
    ? 0
    : (intFlag(args, "--backfill-every") ?? 12);
  const pages = intFlag(args, "--pages");
  // Breite vor Tiefe: Für die Aufzeichnung zählen verschiedene Pools, nicht
  // wiederholte Messungen derselben (KONZEPT-ML.md 3.1).
  const top = intFlag(args, "--top") ?? 40;

  // Prüfbericht: beurteilt die Aufzeichnung, statt nur Zahlen zu zeigen.
  if (args.includes("--check")) {
    console.log("Prüfe die Aufzeichnung…\n");
    try {
      const metrics = await store.healthMetrics(new Date(), intervalMin > 0 ? Math.min(15, intervalMin) : 15);
      console.log(formatHealthReport(metrics));
      console.log("\n" + formatTrackStatus(await store.stats()));
      console.log("\n" + formatFeatureVersions(await store.featureVersions()));

      // Der Bericht selbst ist das Ergebnis — deshalb standardmäßig
      // Rückgabewert 0, sonst überdeckt pnpm ihn mit Fehlerrauschen, das wie
      // ein Absturz aussieht. `--strict` liefert einen Rückgabewert für
      // automatisierte Auswertung.
      if (!args.includes("--strict")) return 0;
      const { evaluateTrackHealth, overallHealth } = await import("@lping/core");
      return overallHealth(evaluateTrackHealth(metrics)) === "fail" ? 1 : 0;
    } catch (error) {
      console.error(explainFailure(error));
      return 1;
    }
  }

  if (statusOnly) {
    console.log(formatTrackStatus(await store.stats()));
    console.log("\n" + formatFeatureVersions(await store.featureVersions()));
    return 0;
  }

  let config: BotConfig | null = null;
  if (scanEvery > 0) {
    try {
      config = loadDefaultsFromDir(configDir);
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        console.error(error.message);
        return 1;
      }
      throw error;
    }
  }

  const deps: TrackDeps = {
    store,
    getPools: (addresses) => meteora.getPairsByAddresses(addresses),
    log: (line) => console.log(`  ${line}`),
  };

  const scanDeps: ScanDeps = {
    meteora,
    dexscreener: new DexScreenerAdapter(),
    rugcheck: new RugcheckAdapter(),
    jupiter: new JupiterAdapter(),
    jupiterTokens: new JupiterTokenAdapter(),
    persist: new db.ScanRepo(prisma),
    track: store,
    log: () => {},
  };

  // Messraster je Pool: folgt dem Zyklus-Intervall, aber nie grober als 15 min.
  // Wer den Zyklus verkürzt, will feiner auflösen — sonst liefen die zusätzlichen
  // Durchgänge ins Leere.
  const denseIntervalMin = intervalMin > 0 ? Math.min(15, intervalMin) : 15;

  let cycle = 0;
  const runCycle = async (): Promise<void> => {
    console.log(`\n=== Aufzeichnung ${new Date().toISOString()} ===`);

    // Entdeckung: neue Pools finden und ihre Merkmale festhalten.
    if (config !== null && cycle % scanEvery === 0) {
      console.log("Neue Pools suchen…");
      try {
        const summary = await runScan(scanDeps, config, {
          topPerPreset: top,
          ...(pages !== undefined ? { pages } : {}),
        });
        console.log(
          `  ${summary.poolsScanned} Pools geprüft, ${summary.tracked} Merkmalsvektoren aufgezeichnet`,
        );
      } catch (error) {
        // Ein fehlgeschlagener Scan darf das Tracking nicht aufhalten: die
        // Verläufe bereits bekannter Pools sind wertvoller als neue Funde.
        console.log(`  ! Suche fehlgeschlagen: ${error instanceof Error ? error.message : error}`);
      }
    }
    // Verfolgung: Messpunkte der bekannten Pools schreiben.
    const result = await runTrackCycle(deps, { limit, denseIntervalMin });
    for (const note of result.notes) console.log(`  ! ${note}`);

    // Nachladen: Preis-, Volumen- und Gebührenverlauf rückwirkend holen.
    // Läuft nach der Verfolgung, weil das Messraster Vorrang hat — eine
    // Momentaufnahme ist nicht nachholbar, die Historie schon.
    if (backfillEvery > 0 && cycle % backfillEvery === 0) {
      console.log("Historie nachladen…");
      try {
        const backfill = await runBackfill(
          {
            store,
            getHistory: (address, query) => meteora.getHistory(address, query),
            log: (line) => console.log(`  ${line}`),
          },
          {},
        );
        for (const note of backfill.notes) console.log(`  ! ${note}`);
      } catch (error) {
        // Wie beim Scan: Das Nachladen darf die Aufzeichnung nicht aufhalten.
        console.log(
          `  ! Nachladen fehlgeschlagen: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    cycle++;
    console.log("\n" + formatTrackStatus(await store.stats()));
  };

  try {
    await runCycle();
  } catch (error) {
    console.error("\n" + explainFailure(error));
    if (intervalMin === 0) return 1;
  }

  if (intervalMin > 0) {
    console.log(
      `\nLaufender Betrieb: nächster Durchgang in ${intervalMin} min (Abbruch mit Strg+C).`,
    );
    for (;;) {
      await sleep(intervalMin * 60_000);
      try {
        await runCycle();
      } catch (error) {
        console.error("\n" + explainFailure(error));
      }
    }
  }
  return 0;
}

/**
 * Historie nachladen (KONZEPT-ML.md 3.3).
 *
 * Anders als die Aufzeichnung braucht dieses Kommando keine Kalenderzeit: Es
 * holt Preis-, Volumen- und Gebührenverlauf rückwirkend. Zwei Anwendungsfälle:
 * Lücken schließen, die eine Unterbrechung gerissen hat, und neu entdeckten
 * Pools ihre Vorgeschichte mitgeben.
 */
async function cmdBackfill(args: string[]): Promise<number> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(
      "backfill benötigt eine Datenbank.\n" +
        "Setup: docker compose up -d && pnpm db:generate && pnpm db:migrate",
    );
    return 1;
  }

  const db = await import("@lping/db");
  const store = new db.TrackRepo(db.createPrisma());
  const meteora = new MeteoraAdapter();

  let timeframe;
  try {
    timeframe = parseTimeframe(stringFlag(args, "--timeframe"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  if (args.includes("--status")) {
    console.log(formatHistoryStats(await store.historyStats(timeframe)));
    return 0;
  }

  const deps: BackfillDeps = {
    store,
    getHistory: (address, query) => meteora.getHistory(address, query),
    log: (line) => console.log(`  ${line}`),
  };

  console.log(`Lade Historie nach (${timeframe})…\n`);
  try {
    const result = await runBackfill(deps, {
      timeframe,
      ...(intFlag(args, "--lookback-hours") !== undefined
        ? { lookbackHours: intFlag(args, "--lookback-hours")! }
        : {}),
      ...(intFlag(args, "--limit") !== undefined ? { limit: intFlag(args, "--limit")! } : {}),
      ...(intFlag(args, "--chunk-hours") !== undefined
        ? { chunkHours: intFlag(args, "--chunk-hours")! }
        : {}),
      ...(args.includes("--active-only") ? { activeOnly: true } : {}),
    });
    for (const note of result.notes) console.log(`  ! ${note}`);
    console.log("\n" + formatHistoryStats(await store.historyStats(timeframe)));
    return 0;
  } catch (error) {
    console.error("\n" + explainFailure(error));
    return 1;
  }
}

/** Übersetzt technische Fehler in eine Meldung, mit der man etwas anfangen kann. */
function explainFailure(error: unknown): string {
  if (isDatabaseUnreachable(error)) {
    return (
      "Zyklus abgebrochen: Die Datenbank ist nicht erreichbar.\n" +
      "  → Läuft Docker Desktop? (Wal-Symbol in der Menüleiste)\n" +
      "  → Datenbank starten:  docker compose up -d\n" +
      "  Bereits gesammelte Daten bleiben dabei erhalten."
    );
  }
  if (error instanceof AdapterError) {
    const host = safeHost(error.meta.url);
    const base = `Zyklus abgebrochen: ${host} nicht erreichbar (${error.kind}).`;
    switch (error.kind) {
      case "network":
      case "timeout":
        return `${base}\n  → Internetverbindung prüfen und erneut versuchen.`;
      case "http":
        return error.meta.status === 429
          ? `${base}\n  → Zu viele Anfragen. Ein paar Minuten warten, dann erneut versuchen.`
          : `${base} HTTP ${error.meta.status ?? "?"}\n  → Dienst antwortet gerade nicht; später erneut versuchen.`;
      case "validation":
      case "parse":
        return (
          `${base}\n  → Die API hat ein unerwartetes Format geliefert; vermutlich hat sie sich geändert.\n` +
          `     Bitte diese Meldung melden: ${error.message}`
        );
    }
  }
  return `Zyklus fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Erkennt eine nicht erreichbare Datenbank. Bewusst über Name und Text statt
 * über Prisma-Typen: Der Bot soll nicht direkt von @prisma/client abhängen.
 */
function isDatabaseUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name.includes("PrismaClientInitialization") ||
    /Can't reach database server|ECONNREFUSED|Connection refused/i.test(error.message)
  );
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function stringFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  if (raw === undefined || raw.startsWith("--")) {
    throw new Error(`${name} erwartet einen Wert`);
  }
  return raw;
}

function intFlag(args: string[], name: string): number | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const raw = args[index + 1];
  const value = raw !== undefined ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} erwartet eine positive Ganzzahl, bekommen: ${raw ?? "(nichts)"}`);
  }
  return value;
}

function printHealth(health: AdapterHealth): void {
  const status = health.ok ? "OK " : "FEHLER";
  const latency = health.latencyMs !== null ? `${health.latencyMs} ms` : "-";
  const note = health.note !== undefined ? `  (${health.note})` : "";
  console.log(`  ${health.adapter.padEnd(12)} ${status.padEnd(7)} ${latency}${note}`);
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
