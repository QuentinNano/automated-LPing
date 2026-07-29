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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const configDir = path.join(repoRoot, "config");

async function main(): Promise<number> {
  const command = process.argv[2] ?? "validate";
  switch (command) {
    case "validate":
      return cmdValidate();
    case "health":
      return cmdHealth();
    default:
      console.error(`Unbekanntes Kommando: ${command}\nVerfügbar: validate | health`);
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
