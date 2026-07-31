import { describe, expect, it } from "vitest";
import {
  calibrate,
  calibrationPreset,
  fitPoolLiquidityBins,
  WSOL_MINT,
  type CalibrationInput,
  type RealPosition,
  type TrackPoint,
} from "@lping/core";
import { loadDefaultConfig, TOKEN_MINT } from "./builders";

const config = loadDefaultConfig();
const preset = config.presets["balanced"]!;
const options = { preset, global: config.global };

const T0 = new Date("2026-07-25T12:00:00Z");
const POOL = {
  poolAddress: "PoolA",
  mintX: TOKEN_MINT,
  mintY: WSOL_MINT,
  binStep: 50,
  rewardMints: [] as string[],
};

/** Seitwärts laufender Verlauf im Fünf-Minuten-Raster. */
function series(count: number): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(T0.getTime() + i * 5 * 60_000),
    priceNative: 0.001,
    tvlUsd: 250_000,
    solPriceUsd: 180,
    volume24hUsd: 1_250_000,
    fees24hUsd: 12_500,
    protocolFeePct: 10,
    dynamicFeePct: null,
    baseFeePct: 1,
    windows: null,
  }));
}

function position(overrides: Partial<RealPosition> = {}): RealPosition {
  return {
    positionAddress: "PosA",
    poolAddress: "PoolA",
    status: "closed",
    openedAt: T0,
    closedAt: new Date(T0.getTime() + 3 * 3_600_000),
    depositSol: 5,
    feesSol: 0.02,
    pnlSol: -0.1,
    minBinId: -25,
    maxBinId: 24,
    ...overrides,
  };
}

function input(overrides: Partial<RealPosition> = {}, points = 40): CalibrationInput {
  return { position: position(overrides), series: series(points), pool: POOL };
}

describe("calibrate", () => {
  it("stellt gemessene und modellierte Gebühren als Faktor gegenüber", () => {
    const result = calibrate([input()], options);

    expect(result.skipped).toEqual([]);
    expect(result.cases).toHaveLength(1);
    const entry = result.cases[0]!;
    expect(entry.binWidth).toBe(50);
    expect(entry.depositSol).toBe(5);
    expect(entry.measuredFeesSol).toBe(0.02);
    expect(entry.modelledFeesSol).toBeGreaterThan(0);
    expect(entry.factor).toBeCloseTo(entry.measuredFeesSol / entry.modelledFeesSol, 12);
    expect(result.medianFactor).toBe(entry.factor);
  });

  it("benutzt die Bin-Breite der echten Position, nicht die des Presets", () => {
    const eng = calibrate([input({ minBinId: -10, maxBinId: 9 })], options).cases[0]!;
    const weit = calibrate([input({ minBinId: -100, maxBinId: 99 })], options).cases[0]!;

    expect(eng.binWidth).toBe(20);
    expect(weit.binWidth).toBe(200);
    // Breiter heißt weniger eigener Anteil je berührtem Bin — der modellierte
    // Ertrag muss also fallen.
    expect(weit.modelledFeesSol).toBeLessThan(eng.modelledFeesSol);
  });

  it("überspringt, was sich nicht vergleichen lässt, statt zu raten", () => {
    const result = calibrate(
      [
        input({ positionAddress: "P1", minBinId: undefined, maxBinId: undefined }),
        input({ positionAddress: "P2", depositSol: null }),
        input({ positionAddress: "P3", feesSol: null }),
        input({ positionAddress: "P4", closedAt: T0 }),
      ],
      options,
    );

    expect(result.cases).toEqual([]);
    expect(result.skipped.map((s) => s.positionAddress)).toEqual(["P1", "P2", "P3", "P4"]);
    expect(result.skipped[0]!.reason).toMatch(/Bin-Range/);
    expect(result.skipped[1]!.reason).toMatch(/Einsatz/);
    expect(result.skipped[2]!.reason).toMatch(/Gebührenertrag/);
  });

  it("rechnet nur über die Lebensdauer der Position", () => {
    // Derselbe Verlauf, einmal mit einer Position über eine Stunde und einmal
    // über drei: Gebühren fallen über die Zeit an, also muss der längere Fall
    // mehr modellieren.
    const kurz = calibrate(
      [input({ closedAt: new Date(T0.getTime() + 3_600_000) })],
      options,
    ).cases[0]!;
    const lang = calibrate([input()], options).cases[0]!;

    expect(kurz.hours).toBeCloseTo(1, 6);
    expect(lang.hours).toBeCloseTo(3, 6);
    expect(lang.modelledFeesSol).toBeGreaterThan(kurz.modelledFeesSol);
  });

  it("nimmt den Median über mehrere Fälle", () => {
    const result = calibrate(
      [
        input({ positionAddress: "P1", feesSol: 0.01 }),
        input({ positionAddress: "P2", feesSol: 0.02 }),
        input({ positionAddress: "P3", feesSol: 0.03 }),
      ],
      options,
    );
    expect(result.cases).toHaveLength(3);
    expect(result.medianFactor).toBe(result.cases[1]!.factor);
  });
});

describe("calibrationPreset", () => {
  it("schaltet alles ab, was den Vergleich verkürzen würde", () => {
    const pinned = calibrationPreset(preset, 80, 5);
    // Feste Breite statt Herleitung.
    expect(pinned.binRange).toEqual({ min: 80, max: 80 });
    // Kein Rebalance, kein früher Ausstieg — sonst verglichen wir Gebühren über
    // verschiedene Zeiträume und verschiedene Geometrien.
    expect(pinned.rebalance.enabled).toBe(false);
    expect(pinned.stopLossPct).toBe(90);
    expect(pinned.maxHoldHours).toBeGreaterThanOrEqual(5);
    expect(pinned.exit.feeStallMinPctPerDay).toBe(0);
  });

  it("bleibt innerhalb der Schema-Grenzen", () => {
    const lang = calibrationPreset(preset, 80, 24 * 365);
    expect(lang.maxHoldHours).toBeLessThanOrEqual(24 * 90);
  });
});

describe("fitPoolLiquidityBins", () => {
  it("findet den Wert, der die gemessenen Gebühren am besten trifft", () => {
    // Ein Fall, dessen gemessene Gebühren genau dem entsprechen, was das Modell
    // bei poolLiquidityBins = 100 rechnet.
    const ziel = 100;
    const modelliert = calibrate([input()], {
      ...options,
      global: { ...config.global, paper: { ...config.global.paper, poolLiquidityBins: ziel } },
    }).cases[0]!.modelledFeesSol;

    const fitted = fitPoolLiquidityBins([input({ feesSol: modelliert })], options);
    expect(fitted).not.toBeNull();
    expect(fitted!.poolLiquidityBins).toBe(ziel);
    expect(fitted!.medianFactor).toBeCloseTo(1, 6);
  });

  it("liefert null, wenn kein Fall vergleichbar ist", () => {
    expect(fitPoolLiquidityBins([input({ minBinId: undefined })], options)).toBeNull();
  });
});
