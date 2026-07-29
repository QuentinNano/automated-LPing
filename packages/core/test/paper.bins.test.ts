import { describe, expect, it } from "vitest";
import { applyPriceMove, binIdFromPrice, binPrice, openBins, strategyWeights, totalsOf } from "@lping/core";

describe("Bin-Mathematik", () => {
  it("binPrice folgt (1 + binStep/10000)^i", () => {
    expect(binPrice(0, 100)).toBe(1);
    expect(binPrice(1, 100)).toBeCloseTo(1.01);
    expect(binPrice(-1, 100)).toBeCloseTo(1 / 1.01);
    expect(binPrice(10, 25)).toBeCloseTo(Math.pow(1.0025, 10));
  });

  it("binIdFromPrice ist invers zu binPrice", () => {
    for (const binStep of [10, 25, 100, 400]) {
      for (const id of [-50, -1, 0, 1, 37]) {
        expect(binIdFromPrice(binPrice(id, binStep), binStep)).toBe(id);
      }
    }
  });

  it("Strategie-Gewichte summieren auf 1 und haben die erwartete Form", () => {
    for (const strategy of ["Spot", "Curve", "BidAsk"] as const) {
      const weights = strategyWeights(21, strategy);
      expect(weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
      expect(weights).toHaveLength(21);
    }
    const spot = strategyWeights(21, "Spot");
    expect(new Set(spot.map((w) => w.toFixed(6))).size).toBe(1);

    const curve = strategyWeights(21, "Curve");
    expect(curve[10]!).toBeGreaterThan(curve[0]!);
    expect(curve[10]!).toBeGreaterThan(curve[20]!);

    const bidask = strategyWeights(21, "BidAsk");
    expect(bidask[0]!).toBeGreaterThan(bidask[10]!);
    expect(bidask[20]!).toBeGreaterThan(bidask[10]!);
  });
});

describe("openBins", () => {
  it("quote_only legt ausschließlich SOL-Bins unterhalb des Preises an", () => {
    const opened = openBins({
      price: 1,
      binStep: 100,
      binCount: 20,
      strategy: "BidAsk",
      sided: "quote_only",
      depositSol: 10,
    });
    expect(opened.bins).toHaveLength(20);
    expect(opened.swappedSol).toBe(0);
    for (const bin of opened.bins) {
      expect(bin.price).toBeLessThan(1);
      expect(bin.token).toBe(0);
    }
    const totals = totalsOf(opened.bins, 1);
    expect(totals.solAmount).toBeCloseTo(10);
    expect(totals.tokenAmount).toBe(0);
  });

  it("balanced verteilt um den Preis und tauscht die Oberseite in Token", () => {
    const opened = openBins({
      price: 1,
      binStep: 100,
      binCount: 20,
      strategy: "Curve",
      sided: "balanced",
      depositSol: 10,
    });
    expect(opened.swappedSol).toBeGreaterThan(0);
    expect(opened.swappedSol).toBeLessThan(10);
    const totals = totalsOf(opened.bins, 1);
    // Gesamtwert bleibt der Einsatz (Swap-Kosten bucht die Engine separat).
    expect(totals.valueSol).toBeCloseTo(10, 6);
    expect(totals.tokenAmount).toBeGreaterThan(0);
    expect(totals.solAmount).toBeGreaterThan(0);
  });
});

describe("applyPriceMove", () => {
  it("fallender Preis wandelt SOL-Bins in Token (Buy the dip)", () => {
    const opened = openBins({
      price: 1,
      binStep: 100,
      binCount: 10,
      strategy: "Spot",
      sided: "quote_only",
      depositSol: 10,
    });
    // Preis fällt unter alle Bins → alles in Token.
    const moved = applyPriceMove(opened.bins, 0.5);
    expect(totalsOf(moved, 0.5).solAmount).toBe(0);
    expect(totalsOf(moved, 0.5).tokenAmount).toBeGreaterThan(0);
  });

  it("steigender Preis wandelt Token-Bins zurück in SOL", () => {
    const opened = openBins({
      price: 1,
      binStep: 100,
      binCount: 10,
      strategy: "Spot",
      sided: "quote_only",
      depositSol: 10,
    });
    const down = applyPriceMove(opened.bins, 0.5);
    const up = applyPriceMove(down, 2);
    const totals = totalsOf(up, 2);
    expect(totals.tokenAmount).toBe(0);
    // Jede Bin handelt zu ihrem eigenen Preis — ein Roundtrip runter und wieder
    // rauf ist damit wertneutral. Das ist die zentrale Eigenschaft: der
    // LP-Gewinn stammt aus Fees, NICHT aus dem Durchlaufen der Range.
    expect(totals.solAmount).toBeCloseTo(10, 9);
  });

  it("Preisverfall ohne Rückkehr bedeutet Verlust in SOL (Impermanent Loss)", () => {
    const opened = openBins({
      price: 1,
      binStep: 100,
      binCount: 10,
      strategy: "Spot",
      sided: "quote_only",
      depositSol: 10,
    });
    // Preis bricht unter die Range: alles wurde in Token getauscht, der
    // jetzt weniger wert ist als der eingesetzte SOL-Betrag.
    const crashed = applyPriceMove(opened.bins, 0.2);
    expect(totalsOf(crashed, 0.2).valueSol).toBeLessThan(10);
  });

  it("ist verlustfrei bezüglich Wert am Bin-Preis (kein Wert entsteht aus dem Nichts)", () => {
    const opened = openBins({
      price: 1,
      binStep: 100,
      binCount: 10,
      strategy: "Spot",
      sided: "quote_only",
      depositSol: 10,
    });
    const bin = opened.bins[0]!;
    const moved = applyPriceMove([bin], bin.price * 0.999);
    const after = moved[0]!;
    expect(after.token * bin.price).toBeCloseTo(bin.sol, 9);
  });
});
