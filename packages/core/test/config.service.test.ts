import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigService, ConfigValidationError, MemoryConfigStore } from "@lping/core";

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

describe("ConfigService", () => {
  it("seedet Defaults als Version 1", async () => {
    const service = await ConfigService.init(new MemoryConfigStore(), loadDefaults());
    expect(service.version).toBe(1);
    expect(service.config.global.maxTotalExposureSol).toBe(60);
  });

  it("lädt eine vorhandene Version statt neu zu seeden", async () => {
    const store = new MemoryConfigStore();
    const first = await ConfigService.init(store, loadDefaults());
    await first.update({ global: { maxTotalExposureSol: 25 } }, { actor: "test" });

    const second = await ConfigService.init(store, loadDefaults());
    expect(second.version).toBe(2);
    expect(second.config.global.maxTotalExposureSol).toBe(25);
  });

  it("wendet Patches versioniert an und benachrichtigt Subscriber", async () => {
    const service = await ConfigService.init(new MemoryConfigStore(), loadDefaults());
    const seen: number[] = [];
    const unsubscribe = service.onChange((next) => seen.push(next.version));

    const stored = await service.update(
      { presets: { degen: { stopLossPct: 12 } } },
      { actor: "ui", reason: "tighter stop" },
    );

    expect(stored.version).toBe(2);
    expect(service.config.presets["degen"]!.stopLossPct).toBe(12);
    // Patch darf Nachbarwerte und andere Presets nicht anfassen:
    expect(service.config.presets["degen"]!.minScore).toBe(65);
    expect(service.config.presets["konservativ"]!.stopLossPct).toBe(20);
    expect(seen).toEqual([2]);

    unsubscribe();
    await service.update({ global: { minSolReserve: 1 } }, { actor: "ui" });
    expect(seen).toEqual([2]);
  });

  it("verwirft ungültige Patches ohne Versionswechsel", async () => {
    const service = await ConfigService.init(new MemoryConfigStore(), loadDefaults());
    await expect(
      service.update({ global: { dailyLossLimitPct: 60 } }, { actor: "ui" }),
    ).rejects.toThrowError(ConfigValidationError);
    expect(service.version).toBe(1);
    expect(service.config.global.dailyLossLimitPct).toBe(5);
  });

  it("migriert eine veraltete gespeicherte Config statt sie abzulehnen", async () => {
    const store = new MemoryConfigStore();
    // Stand aus einer früheren Schema-Version: alte Preset-Namen, kein
    // paper-Block, keine labels — nur die getunten Werte sind interessant.
    await store.append({
      config: {
        global: { maxTotalExposureSol: 42, dailyLossLimitPct: 3, hardLossLimitPct: 9 },
        presets: {
          degen: { stopLossPct: 11 },
          multiday: { stopLossPct: 33 },
        },
      } as never,
      actor: "test",
      reason: "altes Schema",
    });

    const service = await ConfigService.init(store, loadDefaults());

    // Migration ist als neue Version dokumentiert, nicht still überschrieben.
    expect(service.version).toBe(2);
    const history = await service.history();
    expect(history[0]?.reason).toContain("Schema-Migration");

    // Getunte Werte überleben …
    expect(service.config.global.maxTotalExposureSol).toBe(42);
    expect(service.config.presets["degen"]!.stopLossPct).toBe(11);
    // … neue Pflichtfelder kommen aus den Defaults …
    expect(service.config.global.paper.capitalPerPresetSol).toBe(25);
    expect(service.config.presets["degen"]!.label).toBe("Degen");
    // … und Presets, die es nicht mehr gibt, verschwinden.
    expect(service.config.presets["multiday"]).toBeUndefined();
    expect(Object.keys(service.config.presets)).toEqual([
      "konservativ",
      "balanced",
      "degen",
    ]);
  });

  it("fällt auf Defaults zurück, wenn die Zusammenführung widersprüchlich wäre", async () => {
    const store = new MemoryConfigStore();
    // Alter Kapitalanteil, der mit der neuen Preset-Aufteilung über 100 % käme.
    await store.append({
      config: {
        global: { maxTotalExposureSol: 42 },
        presets: { degen: { capitalSharePct: 90 } },
      } as never,
      actor: "test",
      reason: "altes Schema",
    });

    const service = await ConfigService.init(store, loadDefaults());

    // Startfähig statt korrekt-aber-tot …
    expect(service.version).toBe(2);
    expect(service.config.presets["degen"]!.capitalSharePct).toBe(25);
    expect(service.config.global.maxTotalExposureSol).toBe(60);
    // … und der Verlust der getunten Werte ist in der Historie dokumentiert.
    const history = await service.history();
    expect(history[0]?.reason).toContain("Defaults wiederhergestellt");
    expect(history[0]?.reason).toContain("capitalSharePct");
  });

  it("liefert die Historie neueste zuerst", async () => {
    const service = await ConfigService.init(new MemoryConfigStore(), loadDefaults());
    await service.update({ global: { profitSweepThresholdSol: 3 } }, { actor: "ui" });
    const history = await service.history();
    expect(history.map((h) => h.version)).toEqual([2, 1]);
  });
});
