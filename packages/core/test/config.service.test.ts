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
    presets: { degen: read("degen.json"), multiday: read("multiday.json") },
  };
}

describe("ConfigService", () => {
  it("seedet Defaults als Version 1", async () => {
    const service = await ConfigService.init(new MemoryConfigStore(), loadDefaults());
    expect(service.version).toBe(1);
    expect(service.config.global.maxTotalExposureSol).toBe(20);
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
    expect(service.config.presets.degen.stopLossPct).toBe(12);
    // Patch darf Nachbarwerte nicht anfassen:
    expect(service.config.presets.degen.minScore).toBe(65);
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

  it("liefert die Historie neueste zuerst", async () => {
    const service = await ConfigService.init(new MemoryConfigStore(), loadDefaults());
    await service.update({ global: { profitSweepThresholdSol: 3 } }, { actor: "ui" });
    const history = await service.history();
    expect(history.map((h) => h.version)).toEqual([2, 1]);
  });
});
