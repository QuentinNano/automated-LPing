import "dotenv/config";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ConfigValidationError, type AdapterHealth, type BotConfig } from "@lping/core";
import {
  DexScreenerAdapter,
  FabriqAdapter,
  JupiterAdapter,
  MeteoraAdapter,
  RugcheckAdapter,
} from "@lping/adapters";
import { loadDefaultsFromDir } from "./loadConfig";
import { cmdFabriqCheck } from "./fabriqCheck";
import { formatScanTable, runScan, type ScanDeps } from "./scan";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configDir = path.join(repoRoot, "config");

async function main(): Promise<number> {
  const command = process.argv[2] ?? "validate";
  switch (command) {
    case "validate":
      return cmdValidate();
    case "health":
      return cmdHealth();
    case "fabriq:check":
      return cmdFabriqCheck(process.argv[3]);
    case "scan":
      return cmdScan(process.argv.slice(3));
    default:
      console.error(
        `Unbekanntes Kommando: ${command}\nVerfügbar: validate | health | scan | fabriq:check <URL>`,
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
  for (const kind of ["degen", "multiday"] as const) {
    const preset = config.presets[kind];
    console.log(
      `  ${kind.padEnd(8)}: ${preset.enabled ? "aktiv" : "aus"}, ` +
        `${preset.capitalSharePct}% Kapital, max ${preset.maxPositions} Positionen, ` +
        `${preset.strategy.type}/${preset.strategy.sided}, SL ${preset.stopLossPct}%`,
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
  if (!noDb && process.env["DATABASE_URL"] !== undefined && process.env["DATABASE_URL"] !== "") {
    try {
      const { createPrisma, ScanRepo } = await import("@lping/db");
      persist = new ScanRepo(createPrisma());
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
    persist,
    log: (line) => console.log(`  ${line}`),
  };

  console.log(`Scan gestartet (pages=${pages}, top=${top} je Preset)…\n`);
  const summary = await runScan(deps, config, { pages, topPerPreset: top });
  console.log("\n" + formatScanTable(summary));
  return 0;
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
