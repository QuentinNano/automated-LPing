import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigValidationError, parseBotConfig } from "@lping/core";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function loadDefaults() {
  const read = (name: string) =>
    JSON.parse(readFileSync(path.join(repoRoot, "config", name), "utf8")) as unknown;
  return {
    global: read("global.json"),
    presets: {
      konservativ: read("konservativ.json"),
      balanced: read("balanced.json"),
      degen: read("degen.json"),
    },
  };
}

describe("BotConfigSchema", () => {
  it("akzeptiert die eingecheckten Default-Konfigurationen (3 Presets)", () => {
    const config = parseBotConfig(loadDefaults());
    expect(config.global.paperTrading).toBe(true);
    expect(Object.keys(config.presets)).toEqual(["konservativ", "balanced", "degen"]);
    expect(config.presets["degen"]!.strategy).toEqual({ type: "BidAsk", sided: "quote_only" });
    expect(config.presets["konservativ"]!.rebalance.enabled).toBe(true);
    expect(config.presets["balanced"]!.label).toBe("Balanced");
  });

  it("erlaubt frei benannte Presets", () => {
    const raw = loadDefaults() as { presets: Record<string, unknown> };
    raw.presets["experiment_a"] = { ...(raw.presets["degen"] as object), capitalSharePct: 0 };
    const config = parseBotConfig(raw);
    expect(config.presets["experiment_a"]).toBeDefined();
  });

  it("lehnt ungültige Preset-IDs ab", () => {
    const raw = loadDefaults() as { presets: Record<string, unknown> };
    raw.presets["Bad Name!"] = raw.presets["degen"];
    expect(() => parseBotConfig(raw)).toThrowError(/Preset-ID/);
  });

  it("lehnt Kapitalanteile über 100 % ab", () => {
    const raw = loadDefaults() as { presets: { degen: { capitalSharePct: number } } };
    raw.presets.degen.capitalSharePct = 80;
    expect(() => parseBotConfig(raw)).toThrowError(ConfigValidationError);
    expect(() => parseBotConfig(raw)).toThrowError(/capitalSharePct/);
  });

  it("zählt deaktivierte Presets nicht in die Kapitalsumme", () => {
    const raw = loadDefaults() as {
      presets: { degen: { capitalSharePct: number; enabled: boolean } };
    };
    raw.presets.degen.capitalSharePct = 80;
    raw.presets.degen.enabled = false;
    expect(() => parseBotConfig(raw)).not.toThrow();
  });

  it("lehnt hardLossLimit <= dailyLossLimit ab", () => {
    const raw = loadDefaults() as { global: { hardLossLimitPct: number } };
    raw.global.hardLossLimitPct = 4;
    expect(() => parseBotConfig(raw)).toThrowError(/hardLossLimitPct/);
  });

  it("lehnt Compounding bei convertToSolPct=100 ab", () => {
    const raw = loadDefaults() as {
      presets: {
        konservativ: { compound: { enabled: boolean }; feeHarvest: { convertToSolPct: number } };
      };
    };
    raw.presets.konservativ.compound.enabled = true;
    raw.presets.konservativ.feeHarvest.convertToSolPct = 100;
    expect(() => parseBotConfig(raw)).toThrowError(/Compounding/);
  });

  it("lehnt Preset-maxPositions über global.maxOpenPositions ab", () => {
    const raw = loadDefaults() as { presets: { degen: { maxPositions: number } } };
    raw.presets.degen.maxPositions = 20;
    expect(() => parseBotConfig(raw)).toThrowError(/maxOpenPositions/);
  });
});
