import { describe, expect, it } from "vitest";
import { computeScore } from "@lping/core";
import { buildInput, buildMarket, loadDefaultConfig } from "./builders";

const config = loadDefaultConfig();

describe("Score-Engine", () => {
  it("bewertet einen gesunden Degen-Kandidaten hoch (>= 75)", () => {
    const score = computeScore(buildInput("degen", config));
    expect(score.total).toBeGreaterThanOrEqual(75);
    expect(score.total).toBeLessThanOrEqual(100);
  });

  it("Komponenten summieren zum Total und respektieren ihre Maxima", () => {
    const score = computeScore(buildInput("degen", config));
    const sum = score.components.reduce((acc, c) => acc + c.points, 0);
    expect(score.total).toBeCloseTo(sum, 1);
    expect(score.components.map((c) => [c.id, c.max])).toEqual([
      ["fee_yield", 35],
      ["market_quality", 25],
      ["safety_margin", 20],
      ["momentum", 10],
      ["yield_per_variance", 10],
    ]);
    for (const component of score.components) {
      expect(component.points).toBeGreaterThanOrEqual(0);
      expect(component.points).toBeLessThanOrEqual(component.max);
    }
  });

  it("ohne Marktdaten fallen Markt-Qualität und Momentum auf 0", () => {
    const score = computeScore(buildInput("degen", config, { market: null }));
    const byId = new Map(score.components.map((c) => [c.id, c]));
    expect(byId.get("market_quality")?.points).toBe(0);
    expect(byId.get("momentum")?.points).toBe(0);
  });

  it("belohnt Gebührenertrag je Varianz, nicht die Herkunft des Kandidaten", () => {
    // Die Quelle sagt nichts über die Güte eines Pools — der frühere
    // Quellen-Bonus vergab an alle denselben Wert und unterschied nie.
    const replicated = computeScore(buildInput("degen", config));
    const fabriq = computeScore(buildInput("degen", config, { source: "fabriq" }));
    expect(fabriq.total).toBeCloseTo(replicated.total, 1);
  });

  it("wertet denselben Gebührenertrag bei höherer Volatilität ab", () => {
    const ruhig = computeScore(
      buildInput("degen", config, { market: buildMarket({ volatilityPctDaily: 25 }) }),
    );
    const wild = computeScore(
      buildInput("degen", config, { market: buildMarket({ volatilityPctDaily: 120 }) }),
    );
    const points = (s: ReturnType<typeof computeScore>) =>
      s.components.find((c) => c.id === "yield_per_variance")?.points ?? 0;

    expect(points(ruhig)).toBeGreaterThan(points(wild));
  });

  it("ohne Volatilitätsschätzung vergibt die Komponente 0 statt zu raten", () => {
    const score = computeScore(
      buildInput("degen", config, { market: buildMarket({ volatilityPctDaily: null }) }),
    );
    const component = score.components.find((c) => c.id === "yield_per_variance");
    expect(component?.points).toBe(0);
  });

  it("parabolisches Momentum wird abgewertet statt belohnt", () => {
    const moderate = computeScore(
      buildInput("degen", config, { market: buildMarket({ priceChangeH6Pct: 40 }) }),
    );
    const parabolic = computeScore(
      buildInput("degen", config, { market: buildMarket({ priceChangeH6Pct: 200 }) }),
    );
    const points = (s: typeof moderate) =>
      s.components.find((c) => c.id === "momentum")?.points ?? -1;
    expect(points(moderate)).toBeGreaterThan(points(parabolic));
    expect(points(parabolic)).toBe(2);
  });

  it("negatives Momentum gibt 0 Punkte", () => {
    const score = computeScore(
      buildInput("degen", config, { market: buildMarket({ priceChangeH6Pct: -20 }) }),
    );
    expect(score.components.find((c) => c.id === "momentum")?.points).toBe(0);
  });
});
