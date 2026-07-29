import { describe, expect, it } from "vitest";
import { classifyForPreset, shortlistRank, USDC_MINT } from "@lping/core";
import { buildPool, loadDefaultConfig } from "./builders";

const config = loadDefaultConfig();

describe("Discovery-Replikation (classifyForPreset)", () => {
  it("nimmt einen aktiven SOL-Pool in beide Shortlists auf", () => {
    const pool = buildPool();
    expect(classifyForPreset(pool, "degen", config.presets.degen).eligible).toBe(true);
    expect(classifyForPreset(pool, "multiday", config.presets.multiday).eligible).toBe(true);
  });

  it("Degen verlangt großen Bin Step, Multiday nicht", () => {
    const pool = buildPool({ binStep: 80 });
    const degen = classifyForPreset(pool, "degen", config.presets.degen);
    expect(degen.eligible).toBe(false);
    expect(degen.reasons.join(" ")).toContain("binStep");
    expect(classifyForPreset(pool, "multiday", config.presets.multiday).eligible).toBe(true);
  });

  it("verwirft Nicht-SOL-Pools und tote Pools", () => {
    expect(
      classifyForPreset(buildPool({ mintY: USDC_MINT }), "degen", config.presets.degen).eligible,
    ).toBe(false);
    expect(
      classifyForPreset(buildPool({ volume24hUsd: 1000 }), "degen", config.presets.degen).eligible,
    ).toBe(false);
    expect(
      classifyForPreset(buildPool({ tvlUsd: 10_000 }), "degen", config.presets.degen).eligible,
    ).toBe(false);
  });

  it("ist großzügiger als die Hard Filters (Ablehnen ist Screening-Aufgabe)", () => {
    // TVL knapp unter dem Hard-Filter-Minimum (50k), aber über 0,5×
    const borderline = buildPool({ tvlUsd: 30_000, volume24hUsd: 150_000 });
    expect(classifyForPreset(borderline, "degen", config.presets.degen).eligible).toBe(true);
  });

  it("shortlistRank sortiert nach Aktivität relativ zur Größe", () => {
    const hot = buildPool({ tvlUsd: 100_000, volume24hUsd: 1_000_000 });
    const calm = buildPool({ tvlUsd: 1_000_000, volume24hUsd: 1_000_000 });
    expect(shortlistRank(hot)).toBeGreaterThan(shortlistRank(calm));
    expect(shortlistRank(buildPool({ volume24hUsd: undefined }))).toBe(0);
  });
});
