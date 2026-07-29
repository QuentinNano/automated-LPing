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
import { formatTrackStatus, runTrackCycle, type TrackDeps } from "./track";
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
    default:
      console.error(
        `Unbekanntes Kommando: ${command}\n` +
          `Verfügbar: validate | health | scan | paper | track | api:check | fabriq:check <URL>`,
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

  const pages = intFlag(args, "--pages") ?? 8;
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

  console.log(`Scan gestartet (pages=${pages}, top=${top} je Preset)…\n`);
  const summary = await runScan(deps, config, { pages, topPerPreset: top });
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
  const pages = intFlag(args, "--pages") ?? 4;
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
      const summary = await runScan(
        {
          meteora,
          dexscreener,
          rugcheck: new RugcheckAdapter(),
          jupiter,
          persist: new (await import("@lping/db")).ScanRepo(
            (await import("@lping/db")).createPrisma(),
          ),
          log: () => {},
        },
        config,
        { pages, topPerPreset: top },
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
 * Eigenes Kommando, weil es unabhängig vom Paper-Trading laufen soll und
 * deutlich häufiger: Der Wert der Aufzeichnung hängt an lückenloser Kalenderzeit.
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

  const { createPrisma, TrackRepo } = await import("@lping/db");
  const store = new TrackRepo(createPrisma());
  const meteora = new MeteoraAdapter();

  const statusOnly = args.includes("--status");
  const intervalMin = intFlag(args, "--interval") ?? 0;
  const limit = intFlag(args, "--limit") ?? 300;

  if (statusOnly) {
    console.log(formatTrackStatus(await store.stats()));
    return 0;
  }

  const deps: TrackDeps = {
    store,
    getPool: (address) => meteora.getPair(address),
    log: (line) => console.log(`  ${line}`),
  };

  const runCycle = async (): Promise<void> => {
    console.log(`\n=== Aufzeichnung ${new Date().toISOString()} ===`);
    const result = await runTrackCycle(deps, { limit });
    for (const note of result.notes) console.log(`  ! ${note}`);
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

/** Übersetzt technische Fehler in eine Meldung, mit der man etwas anfangen kann. */
function explainFailure(error: unknown): string {
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

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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
