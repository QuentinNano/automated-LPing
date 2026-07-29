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
    presets: { degen: read("degen.json"), multiday: read("multiday.json") },
  };
}

describe("BotConfigSchema", () => {
  it("akzeptiert die eingecheckten Default-Konfigurationen", () => {
    const config = parseBotConfig(loadDefaults());
    expect(config.global.paperTrading).toBe(true);
    expect(config.presets.degen.strategy).toEqual({ type: "BidAsk", sided: "quote_only" });
    expect(config.presets.multiday.rebalance.enabled).toBe(true);
  });

  it("lehnt Kapitalanteile über 100 % ab", () => {
    const raw = loadDefaults() as { presets: { degen: { capitalSharePct: number } } };
    raw.presets.degen.capitalSharePct = 80;
    expect(() => parseBotConfig(raw)).toThrowError(ConfigValidationError);
    expect(() => parseBotConfig(raw)).toThrowError(/capitalSharePct/);
  });

  it("lehnt hardLossLimit <= dailyLossLimit ab", () => {
    const raw = loadDefaults() as { global: { hardLossLimitPct: number } };
    raw.global.hardLossLimitPct = 4;
    expect(() => parseBotConfig(raw)).toThrowError(/hardLossLimitPct/);
  });

  it("lehnt Compounding bei convertToSolPct=100 ab", () => {
    const raw = loadDefaults() as {
      presets: { multiday: { compound: { enabled: boolean }; feeHarvest: { convertToSolPct: number } } };
    };
    raw.presets.multiday.compound.enabled = true;
    raw.presets.multiday.feeHarvest.convertToSolPct = 100;
    expect(() => parseBotConfig(raw)).toThrowError(/Compounding/);
  });

  it("lehnt Preset-maxPositions über global.maxOpenPositions ab", () => {
    const raw = loadDefaults() as { presets: { degen: { maxPositions: number } } };
    raw.presets.degen.maxPositions = 20;
    expect(() => parseBotConfig(raw)).toThrowError(/maxOpenPositions/);
  });
});
