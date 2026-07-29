import { describe, expect, it } from "vitest";
import { classifyForPreset, shortlistRank, USDC_MINT } from "@lping/core";
import { buildPool, loadDefaultConfig } from "./builders";

const config = loadDefaultConfig();
const degen = config.presets["degen"]!;
const konservativ = config.presets["konservativ"]!;

describe("Discovery-Replikation (classifyForPreset)", () => {
  it("nimmt einen aktiven SOL-Pool in beide Shortlists auf", () => {
    const pool = buildPool();
    expect(classifyForPreset(pool, degen).eligible).toBe(true);
    expect(classifyForPreset(pool, konservativ).eligible).toBe(true);
  });

  it("Degen verlangt großen Bin Step, Konservativ nicht", () => {
    const pool = buildPool({ binStep: 80 });
    const result = classifyForPreset(pool, degen);
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(" ")).toContain("binStep");
    expect(classifyForPreset(pool, konservativ).eligible).toBe(true);
  });

  it("Konservativ verlangt höhere TVL als Degen", () => {
    // 100k liegt über Degens Schwelle (0,5 × 50k), unter Konservativs (0,5 × 250k).
    const pool = buildPool({ tvlUsd: 100_000, volume24hUsd: 500_000 });
    expect(classifyForPreset(pool, degen).eligible).toBe(true);
    expect(classifyForPreset(pool, konservativ).eligible).toBe(false);
  });

  it("verwirft Nicht-SOL-Pools und tote Pools", () => {
    expect(classifyForPreset(buildPool({ mintY: USDC_MINT }), degen).eligible).toBe(false);
    expect(classifyForPreset(buildPool({ volume24hUsd: 1000 }), degen).eligible).toBe(false);
    expect(classifyForPreset(buildPool({ tvlUsd: 10_000 }), degen).eligible).toBe(false);
  });

  it("ist großzügiger als die Hard Filters (Ablehnen ist Screening-Aufgabe)", () => {
    // TVL knapp unter dem Hard-Filter-Minimum (50k), aber über 0,5×
    const borderline = buildPool({ tvlUsd: 30_000, volume24hUsd: 150_000 });
    expect(classifyForPreset(borderline, degen).eligible).toBe(true);
  });

  it("shortlistRank sortiert nach Aktivität relativ zur Größe", () => {
    const hot = buildPool({ tvlUsd: 100_000, volume24hUsd: 1_000_000 });
    const calm = buildPool({ tvlUsd: 1_000_000, volume24hUsd: 1_000_000 });
    expect(shortlistRank(hot)).toBeGreaterThan(shortlistRank(calm));
    expect(shortlistRank(buildPool({ volume24hUsd: undefined }))).toBe(0);
  });
});
