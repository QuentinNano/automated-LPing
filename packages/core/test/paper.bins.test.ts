import { describe, expect, it } from "vitest";
import {
  applyPriceMove,
  binIdFromPrice,
  binPrice,
  binsForCoverage,
  coverageHorizonHours,
  deriveBinWidth,
  inRangeShare,
  openBins,
  strategyWeights,
  totalsOf,
} from "@lping/core";

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

  it("einseitige Gewichte sind monoton — kein zweiter Schwerpunkt am Preis", () => {
    // Der Fehler, den das verhindert: Über den Index gerechnet erzeugte die
    // V-Form von BidAsk auf einer einseitigen Leiter Schwerpunkte an *beiden*
    // Enden — einen davon direkt unter dem Preis, wo eine Kauforder-Leiter
    // gerade nichts stapeln will. Die mittlere Tiefe blieb leer.
    const bidask = strategyWeights(21, "BidAsk", "quote_only");
    for (let i = 1; i < bidask.length; i++) {
      // Index 0 = fernster Bin, Index 20 = direkt unter dem Preis.
      expect(bidask[i]!).toBeLessThan(bidask[i - 1]!);
    }

    const curve = strategyWeights(21, "Curve", "quote_only");
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeGreaterThan(curve[i - 1]!);
    }

    expect(strategyWeights(21, "Spot", "quote_only")).toEqual(
      strategyWeights(21, "Spot", "balanced"),
    );
  });

  it("zweiseitige Gewichte bleiben unverändert", () => {
    for (const strategy of ["Spot", "Curve", "BidAsk"] as const) {
      expect(strategyWeights(21, strategy, "balanced")).toEqual(
        strategyWeights(21, strategy),
      );
    }
  });
});

describe("deriveBinWidth", () => {
  const binRange = { min: 10, max: 400, coverageSigmas: 1.5 };

  it("deckt bei quote_only dieselbe Sigma-Zahl ab wie balanced je Richtung", () => {
    // Vorher bekam eine einseitige Position die *zweiseitige* Spanne und damit
    // die doppelte Tiefe: 1,5 konfigurierte Sigmas wurden zu 3 gemessenen.
    const zweiseitig = deriveBinWidth({
      binRange,
      binStep: 100,
      horizonHours: 24,
      volatilityPctDaily: 60,
      sided: "balanced",
    });
    const einseitig = deriveBinWidth({
      binRange,
      binStep: 100,
      horizonHours: 24,
      volatilityPctDaily: 60,
      sided: "quote_only",
    });
    // Auf eine Bin genau: beide runden einmal, nur an verschiedenen Stellen.
    expect(Math.abs(einseitig.bins - zweiseitig.bins / 2)).toBeLessThanOrEqual(1);

    // Und die Tiefe entspricht dann tatsächlich coverageSigmas.
    const opened = openBins({
      price: 1,
      binStep: 100,
      binCount: einseitig.bins,
      strategy: "Spot",
      sided: "quote_only",
      depositSol: 1,
    });
    const tiefeInSigma =
      Math.abs(Math.log(binPrice(opened.minBinId, 100))) / (60 / 100);
    expect(tiefeInSigma).toBeCloseTo(1.5, 1);
  });

  it("weist aus, an welche Leitplanke die Herleitung gestoßen ist", () => {
    const eng = deriveBinWidth({
      binRange: { min: 10, max: 40, coverageSigmas: 1.5 },
      binStep: 20,
      horizonHours: 24,
      volatilityPctDaily: 120,
      sided: "balanced",
    });
    expect(eng.clamped).toBe("max");
    expect(eng.bins).toBe(40);
    expect(eng.derived).toBeGreaterThan(40);

    const weit = deriveBinWidth({
      binRange: { min: 200, max: 400, coverageSigmas: 1.5 },
      binStep: 400,
      horizonHours: 1,
      volatilityPctDaily: 5,
      sided: "balanced",
    });
    expect(weit.clamped).toBe("min");
    expect(weit.bins).toBe(200);

    const passend = deriveBinWidth({
      binRange,
      binStep: 100,
      horizonHours: 24,
      volatilityPctDaily: 60,
      sided: "balanced",
    });
    expect(passend.clamped).toBeNull();
    expect(passend.bins).toBe(passend.derived);
  });

  it("fällt ohne Volatilitätsschätzung auf die Mitte zurück und meldet keine Klemmung", () => {
    const ohne = deriveBinWidth({
      binRange,
      binStep: 100,
      horizonHours: 24,
      volatilityPctDaily: null,
      sided: "balanced",
    });
    expect(ohne.bins).toBe(205);
    expect(ohne.derived).toBeNull();
    expect(ohne.clamped).toBeNull();
  });

  it("binsForCoverage ist die Umkehrung von deriveBinWidth", () => {
    const width = deriveBinWidth({
      binRange: { min: 1, max: 1400, coverageSigmas: 2 },
      binStep: 25,
      horizonHours: 6,
      volatilityPctDaily: 80,
      sided: "balanced",
    });
    expect(
      binsForCoverage({
        sigmas: 2,
        volatilityPctDaily: 80,
        binStep: 25,
        horizonHours: 6,
        sided: "balanced",
      }),
    ).toBe(width.derived);
  });
});

describe("coverageHorizonHours", () => {
  it("nimmt den Cooldown, wenn rebalanciert wird — sonst die Haltedauer", () => {
    expect(
      coverageHorizonHours({
        rebalance: { enabled: true, cooldownMin: 120 },
        maxHoldHours: 96,
      }),
    ).toBe(2);
    expect(
      coverageHorizonHours({
        rebalance: { enabled: false, cooldownMin: 120 },
        maxHoldHours: 6,
      }),
    ).toBe(6);
  });

  it("deckelt bei 24 Stunden — √Horizont sonst eine Range, die nichts mehr verdient", () => {
    expect(
      coverageHorizonHours({
        rebalance: { enabled: false, cooldownMin: 0 },
        maxHoldHours: 336,
      }),
    ).toBe(24);
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

describe("inRangeShare", () => {
  const bins = openBins({
    price: 1,
    binStep: 100,
    binCount: 20,
    strategy: "Spot",
    sided: "balanced",
    depositSol: 1,
  }).bins;
  const unten = bins[0]!.price;
  const oben = bins[bins.length - 1]!.price;

  it("ohne Extrema ist es die frühere Ja/Nein-Frage", () => {
    expect(inRangeShare(bins, 1)).toBe(1);
    expect(inRangeShare(bins, oben * 2)).toBe(0);
    expect(inRangeShare(bins, unten / 2)).toBe(0);
  });

  it("misst den Überlappungsanteil, wenn das Intervall die Range verlässt", () => {
    // Vom geometrischen Mittelpunkt der Range bis ebenso weit über ihren
    // oberen Rand hinaus: genau die Hälfte der log-Spanne liegt drinnen.
    const mitte = Math.sqrt(unten * oben);
    const share = inRangeShare(bins, oben, mitte, (oben * oben) / mitte);
    expect(share).toBeCloseTo(0.5, 9);

    // Vollständig innerhalb → 1, vollständig außerhalb → 0.
    expect(inRangeShare(bins, 1, unten, oben)).toBeCloseTo(1, 9);
    expect(inRangeShare(bins, oben * 3, oben * 2, oben * 4)).toBe(0);
  });

  it("ist monoton: ein weiterer Ausschlag kann den Anteil nur senken", () => {
    const eng = inRangeShare(bins, 1, 0.99, 1.01);
    const weit = inRangeShare(bins, 1, unten / 2, oben * 2);
    expect(weit).toBeLessThan(eng);
  });
});
