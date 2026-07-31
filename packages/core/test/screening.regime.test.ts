import { describe, expect, it } from "vitest";
import { assessRegime, regimeBlocksOpening, type RegimeObservation } from "@lping/core";
import { loadDefaultConfig } from "./builders";

const config = loadDefaultConfig();
const regimeConfig = config.global.regime;

/**
 * Der Verlust gegenüber Halten wächst mit σ²/8 je Tag, der Ertrag linear mit
 * der Gebührenrate. Ein Pool mit σ 40 %/Tag verliert also ~2 %/Tag an Varianz —
 * bei 2 %/Tag Gebühren ist das Verhältnis 1.
 */
function pool(id: string, feeRatePctPerDay: number, volatilityPctDaily: number | null): RegimeObservation {
  return { poolAddress: id, feeRatePctPerDay, volatilityPctDaily };
}

function field(count: number, feeRate: number, sigma: number): RegimeObservation[] {
  return Array.from({ length: count }, (_, i) => pool(`P${i}`, feeRate, sigma));
}

describe("assessRegime", () => {
  it("nennt ein Feld ungünstig, dessen Gebühren den Varianzverlust nicht decken", () => {
    // σ 80 %/Tag → Varianzverlust ~8 %/Tag. 2 %/Tag Gebühren decken das nicht.
    const verdict = assessRegime(field(30, 2, 80), regimeConfig);
    expect(verdict.status).toBe("adverse");
    expect(verdict.medianYieldPerVariance).toBeLessThan(1);
    expect(verdict.reason).toMatch(/decken/);
  });

  it("nennt ein ruhiges Feld mit Umschlag günstig", () => {
    // σ 20 %/Tag → Varianzverlust ~0,5 %/Tag. 4 %/Tag Gebühren decken es 8-fach.
    const verdict = assessRegime(field(30, 4, 20), regimeConfig);
    expect(verdict.status).toBe("favourable");
    expect(verdict.medianYieldPerVariance).toBeGreaterThan(regimeConfig.favourableAbove);
  });

  it("unterscheidet zwei Felder mit gleicher Gebührenrate nach ihrer Volatilität", () => {
    // Genau der Punkt: Fee/TVL allein ist kein Gütesiegel.
    const ruhig = assessRegime(field(30, 3, 20), regimeConfig);
    const wild = assessRegime(field(30, 3, 90), regimeConfig);
    expect(ruhig.medianYieldPerVariance!).toBeGreaterThan(wild.medianYieldPerVariance!);
    expect(ruhig.status).not.toBe(wild.status);
  });

  it("zählt jeden Pool einmal, auch wenn er für mehrere Presets in Frage kommt", () => {
    // Sonst gewichtet die Aggregation still nach der Zahl der Presets, für die
    // ein Pool gerade passt.
    const einmal = assessRegime(field(20, 3, 40), regimeConfig);
    const dreifach = assessRegime(
      [...field(20, 3, 40), ...field(20, 3, 40), ...field(20, 3, 40)],
      regimeConfig,
    );
    expect(dreifach.sampled).toBe(einmal.sampled);
    expect(dreifach.medianYieldPerVariance).toBe(einmal.medianYieldPerVariance);
  });

  it("urteilt nicht über zu wenige Pools", () => {
    const verdict = assessRegime(field(3, 2, 80), regimeConfig);
    expect(verdict.status).toBe("unknown");
    expect(verdict.reason).toMatch(/zu dünn/);
  });

  it("zählt Pools ohne Volatilitätsschätzung als übersprungen, nicht als schlecht", () => {
    const verdict = assessRegime(
      [...field(20, 3, 20), ...Array.from({ length: 10 }, (_, i) => pool(`X${i}`, 3, null))],
      regimeConfig,
    );
    expect(verdict.sampled).toBe(20);
    expect(verdict.skipped).toBe(10);
    expect(verdict.status).toBe("favourable");
  });

  it("lässt einen einzelnen Ausreißer das Urteil nicht drehen", () => {
    // Median statt Mittelwert: Ein Pool mit absurdem Verhältnis ist meist ein
    // Messfehler oder ein Wash-Trading-Verdacht.
    const mitAusreisser = assessRegime(
      [...field(30, 2, 80), pool("SPIKE", 10_000, 5)],
      regimeConfig,
    );
    expect(mitAusreisser.status).toBe("adverse");
  });
});

describe("regimeBlocksOpening", () => {
  const verdictWith = (status: "adverse" | "unknown" | "neutral") =>
    ({ status, medianYieldPerVariance: 0.5, sampled: 30, skipped: 0, reason: "" }) as const;

  it("blockiert bei ungünstigem Regime", () => {
    expect(regimeBlocksOpening(verdictWith("adverse"), regimeConfig)).toBe(true);
  });

  it("blockiert nicht ohne Urteil — fehlende Messung ist kein Befund", () => {
    // Ein Tor, das ohne Daten schließt, verhindert genau die Aufzeichnung, aus
    // der die Daten entstünden.
    expect(regimeBlocksOpening(verdictWith("unknown"), regimeConfig)).toBe(false);
    expect(regimeBlocksOpening(verdictWith("neutral"), regimeConfig)).toBe(false);
  });

  it("lässt sich abschalten, ohne die Beurteilung zu verlieren", () => {
    expect(regimeBlocksOpening(verdictWith("adverse"), { ...regimeConfig, enabled: false })).toBe(false);
    expect(regimeBlocksOpening(verdictWith("adverse"), { ...regimeConfig, blockOpening: false })).toBe(false);
  });
});
