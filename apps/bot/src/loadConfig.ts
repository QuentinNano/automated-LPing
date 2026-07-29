import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { parseBotConfig, type BotConfig } from "@lping/core";

/**
 * Lädt die Default-Konfiguration aus dem /config-Verzeichnis und validiert sie.
 * Zur Laufzeit ist das nur der Seed für Version 1 — die gültige Config kommt
 * danach versioniert aus der DB (ConfigService + PrismaConfigStore).
 *
 * Presets werden aus dem Verzeichnis gelesen, nicht aus einer festen Liste:
 * jede JSON-Datei außer `global.json` ist ein Preset, ihr Dateiname die ID.
 * Eine neue Datei genügt, um ein weiteres Risikoprofil zu ergänzen.
 */
export function loadDefaultsFromDir(configDir: string): BotConfig {
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(path.join(configDir, name), "utf8"));

  const presets: Record<string, unknown> = {};
  for (const file of readdirSync(configDir).sort()) {
    if (file === "global.json" || !file.endsWith(".json")) continue;
    presets[path.basename(file, ".json")] = read(file);
  }

  return parseBotConfig({ global: read("global.json"), presets });
}
