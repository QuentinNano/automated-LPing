import { readFileSync } from "node:fs";
import path from "node:path";
import { parseBotConfig, type BotConfig } from "@lping/core";

/**
 * Lädt die Default-Konfiguration aus dem /config-Verzeichnis und validiert sie.
 * Zur Laufzeit ist das nur der Seed für Version 1 — die gültige Config kommt
 * danach versioniert aus der DB (ConfigService + PrismaConfigStore).
 */
export function loadDefaultsFromDir(configDir: string): BotConfig {
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(path.join(configDir, name), "utf8"));
  return parseBotConfig({
    global: read("global.json"),
    presets: { degen: read("degen.json"), multiday: read("multiday.json") },
  });
}
