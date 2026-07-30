import { describe, expect, it } from "vitest";
import {
  estimateVolatilityPctDaily,
  feeYieldPerVariance,
  realizedVolatilityPctDaily,
  type TrackPoint,
} from "@lping/core";

const T0 = Date.parse("2026-07-29T12:00:00Z");

function series(prices: number[], stepMin = 15): TrackPoint[] {
  return prices.map((price, i) => ({
    ts: new Date(T0 + i * stepMin * 60_000),
    priceNative: price,
    tvlUsd: 100_000,
    fees24hUsd: 1_000,
    volume24hUsd: 100_000,
  }));
}

/** Deterministischer Pfad mit vorgegebener Tagesvolatilität. */
function pathWithSigma(sigmaDaily: number, steps: number, stepMin: number): number[] {
  const dt = stepMin / 1440;
  const stepSigma = sigmaDaily * Math.sqrt(dt);
  const prices = [1];
  for (let i = 1; i <= steps; i++) {
    // Abwechselnd auf und ab: Streuung exakt `stepSigma`, kein Zufall nötig.
    prices.push(prices[i - 1]! * Math.exp(i % 2 === 0 ? stepSigma : -stepSigma));
  }
  return prices;
}

describe("realizedVolatilityPctDaily", () => {
  it("misst eine bekannte Volatilität auf dem 15-Minuten-Raster", () => {
    const vol = realizedVolatilityPctDaily(series(pathWithSigma(0.8, 200, 15), 15));
    expect(vol).not.toBeNull();
    expect(vol!).toBeGreaterThan(70);
    expect(vol!).toBeLessThan(90);
  });

  it("liefert dieselbe Volatilität bei anderem Raster", () => {
    // Der eigentliche Zweck der Normierung auf einen Tag: Das
    // Aufzeichnungsraster wird gröber, sobald ein Pool älter als 48 Stunden ist
    // (`trackingIntervalSec`). Ohne Normierung sähe derselbe Markt danach
    // ruhiger aus — eine Volatilitätsänderung, die nur eine Abtastungsänderung
    // ist.
    const fein = realizedVolatilityPctDaily(series(pathWithSigma(0.8, 400, 5), 5));
    const grob = realizedVolatilityPctDaily(series(pathWithSigma(0.8, 100, 60), 60));
    expect(fein).not.toBeNull();
    expect(grob).not.toBeNull();
    expect(Math.abs(fein! - grob!)).toBeLessThan(10);
  });

  it("ist bei einem flachen Verlauf praktisch null", () => {
    expect(realizedVolatilityPctDaily(series([1, 1, 1, 1, 1]))!).toBeCloseTo(0, 6);
  });

  it("braucht genug Punkte, statt aus zweien eine Streuung zu erfinden", () => {
    expect(realizedVolatilityPctDaily(series([1, 1.1]))).toBeNull();
    expect(realizedVolatilityPctDaily([])).toBeNull();
  });

  it("überspringt Punkte ohne Preis", () => {
    const points = series([1, 1.05, 1.02, 1.08]);
    points[1]!.priceNative = null;
    expect(realizedVolatilityPctDaily(points)).not.toBeNull();
  });
});

describe("estimateVolatilityPctDaily", () => {
  it("schätzt aus den Preisänderungen eine Größenordnung", () => {
    const vol = estimateVolatilityPctDaily({ h1: 5, h6: 15, h24: 30 });
    expect(vol).not.toBeNull();
    expect(vol!).toBeGreaterThan(20);
    expect(vol!).toBeLessThan(80);
  });

  it("bewertet Auf- und Abbewegung gleich", () => {
    // Volatilität ist richtungslos. −33 % und +50 % sind dieselbe Bewegung,
    // weshalb über Log-Renditen gerechnet wird und nicht über Prozente.
    const hoch = estimateVolatilityPctDaily({ h24: 50 });
    const runter = estimateVolatilityPctDaily({ h24: -33.333 });
    expect(hoch).not.toBeNull();
    expect(Math.abs(hoch! - runter!)).toBeLessThan(1);
  });

  it("erkennt einen ruhigen Markt als ruhig", () => {
    const ruhig = estimateVolatilityPctDaily({ h1: 0.5, h6: 1, h24: 2 })!;
    const wild = estimateVolatilityPctDaily({ h1: 10, h6: 25, h24: 60 })!;
    expect(ruhig).toBeLessThan(wild);
    expect(ruhig).toBeLessThan(10);
  });

  it("gibt null zurück, wenn keine Änderung bekannt ist", () => {
    expect(estimateVolatilityPctDaily({})).toBeNull();
    expect(estimateVolatilityPctDaily({ h1: null, h6: null, h24: null })).toBeNull();
  });

  it("verkraftet einen Totalverlust ohne NaN", () => {
    expect(estimateVolatilityPctDaily({ h24: -100 })).toBeNull();
  });
});

describe("feeYieldPerVariance", () => {
  it("bevorzugt bei gleichem Ertrag den ruhigeren Pool", () => {
    const ruhig = feeYieldPerVariance(10, 30)!;
    const wild = feeYieldPerVariance(10, 90)!;
    expect(ruhig).toBeGreaterThan(wild);
    // σ verdreifacht → Varianz verneunfacht → Verhältnis auf ein Neuntel.
    expect(ruhig / wild).toBeCloseTo(9, 1);
  });

  it("wächst linear mit dem Gebührenertrag", () => {
    expect(feeYieldPerVariance(20, 50)! / feeYieldPerVariance(10, 50)!).toBeCloseTo(2, 6);
  });

  it("verweigert die Auskunft ohne Volatilität, statt zu raten", () => {
    expect(feeYieldPerVariance(10, null)).toBeNull();
    expect(feeYieldPerVariance(10, 0)).toBeNull();
  });
});
