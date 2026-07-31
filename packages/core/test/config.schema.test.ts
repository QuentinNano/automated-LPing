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

  it("prüft die Summe der Presets erst gegen die Wallet-Grenzen, wenn live gehandelt wird", () => {
    // Ausgeliefert: 4 + 5 + 5 = 14 Positionen gegen maxOpenPositions 10. Je
    // Preset geprüft passierte das anstandslos — die globale Grenze war damit
    // wirkungslos.
    const raw = loadDefaults() as { global: Record<string, unknown> };
    expect(() => parseBotConfig(raw)).not.toThrow();

    raw.global["paperTrading"] = false;
    expect(() => parseBotConfig(raw)).toThrowError(/maxOpenPositions ist 10/);
  });

  it("prüft live auch den Gesamteinsatz aller aktiven Presets", () => {
    const raw = loadDefaults() as { global: Record<string, unknown> };
    raw.global["paperTrading"] = false;
    raw.global["maxOpenPositions"] = 20;
    raw.global["maxTotalExposureSol"] = 10;
    expect(() => parseBotConfig(raw)).toThrowError(/maxTotalExposureSol/);
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

  it("lehnt ein binRange.max ab, das die zugelassene Volatilität nicht trägt", () => {
    // Der Fehler, den das fängt: Die Herleitung läuft still in die Leitplanke,
    // die Position ist dann zu eng ausgelegt — und zwar bevorzugt bei den
    // volatilen Pools, also genau dort, wo die Breite den Unterschied macht.
    const raw = loadDefaults() as {
      presets: { balanced: { binRange: { max: number } } };
    };
    raw.presets.balanced.binRange.max = 60;
    expect(() => parseBotConfig(raw)).toThrowError(ConfigValidationError);
    expect(() => parseBotConfig(raw)).toThrowError(/Standardabweichung/);
  });

  it("prüft die Abdeckung nur, wo überhaupt hergeleitet wird", () => {
    const raw = loadDefaults() as {
      presets: { balanced: { binRange: { max: number; coverageSigmas?: number } } };
    };
    raw.presets.balanced.binRange.max = 60;
    delete raw.presets.balanced.binRange.coverageSigmas;
    expect(() => parseBotConfig(raw)).not.toThrow();
  });

  it("akzeptiert dieselbe Grenze, wenn das Volatilitätsband dazu passt", () => {
    const raw = loadDefaults() as {
      presets: {
        balanced: {
          binRange: { max: number };
          volatilityBoundsPctDaily: { max: number };
        };
      };
    };
    raw.presets.balanced.binRange.max = 60;
    raw.presets.balanced.volatilityBoundsPctDaily.max = 20;
    expect(() => parseBotConfig(raw)).not.toThrow();
  });
});
