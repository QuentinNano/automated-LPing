import { describe, expect, it } from "vitest";
import {
  PresetConfigSchema,
  REFERENCE_POSITION,
  WSOL_MINT,
  computeReplayOutcomes,
  type ReplayPool,
  type TrackPoint,
} from "@lping/core";
import { loadDefaultConfig, TOKEN_MINT } from "./builders";

const T0 = new Date("2026-07-29T12:00:00Z");
const config = loadDefaultConfig();

const pool: ReplayPool = {
  poolAddress: "PoolA",
  mintX: TOKEN_MINT,
  mintY: WSOL_MINT,
  binStep: 100,
};

function point(minutesAfter: number, price: number): TrackPoint {
  return {
    ts: new Date(T0.getTime() + minutesAfter * 60_000),
    priceNative: price,
    tvlUsd: 250_000,
    fees24hUsd: 12_500,
    volume24hUsd: 1_250_000,
    dynamicFeePct: 1.4,
    baseFeePct: 1,
    protocolFeePct: 10,
    solPriceUsd: 180,
    windows: null,
  };
}

/** Seitwärtsverlauf über `hours` Stunden im 5-Minuten-Raster. */
function flat(hours: number, price = 0.001): TrackPoint[] {
  return Array.from({ length: hours * 12 + 1 }, (_, i) => point(i * 5, price));
}

describe("REFERENCE_POSITION", () => {
  it("ist eine gültige Preset-Konfiguration", () => {
    // Die Referenzposition ist eine Konstante im Code und wird deshalb nie vom
    // Schema geprüft. Ohne diesen Test fiele eine Verletzung erst auf, wenn ein
    // Label heimlich falsch gerechnet wäre.
    expect(() => PresetConfigSchema.parse(REFERENCE_POSITION)).not.toThrow();
  });

  it("hat eine feste Breite, damit das Label nicht an einer Schätzung hängt", () => {
    expect(REFERENCE_POSITION.binRange.min).toBe(REFERENCE_POSITION.binRange.max);
    expect(REFERENCE_POSITION.binRange.coverageSigmas).toBeUndefined();
  });

  it("rebalanciert nicht und ist deaktiviert — sie handelt nicht mit", () => {
    expect(REFERENCE_POSITION.rebalance.enabled).toBe(false);
    expect(REFERENCE_POSITION.enabled).toBe(false);
  });
});

describe("computeReplayOutcomes", () => {
  it("liefert je Horizont ein Label", () => {
    const labels = computeReplayOutcomes(T0, flat(2), pool, config.global, [1, 6]);
    expect(labels.map((label) => label.horizonHours)).toEqual([1, 6]);
  });

  it("misst den Netto-Ertrag inklusive Kosten — nicht die Pool-Rate", () => {
    const labels = computeReplayOutcomes(T0, flat(6), pool, config.global, [6]);
    const label = labels[0]!;
    expect(label.replayPnlPct).not.toBeNull();
    // Der Unterschied zu `feeYieldPct`: Dort ist der Wert per Konstruktion
    // positiv, sobald der Pool Gebühren erwirtschaftet. Hier gehen Einstiegs-
    // und Ausstiegskosten ab, und die sind sofort real.
    expect(label.replayVsHodlPct).not.toBeNull();
  });

  it("markiert zensierte Labels statt sie wie vollständige zu zählen", () => {
    // Verlauf über 2 Stunden, Horizont 24 — die Position wird vom Datenende
    // abgeschnitten, nicht vom Horizont.
    const labels = computeReplayOutcomes(T0, flat(2), pool, config.global, [24]);
    expect(labels[0]!.censored).toBe(true);

    // Reicht der Verlauf über den Horizont, endet die Position regulär.
    const complete = computeReplayOutcomes(T0, flat(8), pool, config.global, [6]);
    expect(complete[0]!.censored).toBe(false);
  });

  it("gibt ein leeres Label statt gar keines, wenn nichts simulierbar ist", () => {
    const labels = computeReplayOutcomes(T0, [point(0, 0.001)], pool, config.global, [1]);
    expect(labels[0]).toEqual({
      horizonHours: 1,
      replayPnlPct: null,
      replayVsHodlPct: null,
      censored: false,
    });
  });

  it("ignoriert Punkte vor dem Entscheidungszeitpunkt", () => {
    // Look-Ahead in die andere Richtung: Was vor der Entscheidung lag, gehört
    // dem Label nicht — es beschreibt ausschließlich die Zeit danach.
    const before = point(-60, 0.002);
    const withPast = computeReplayOutcomes(T0, [before, ...flat(6)], pool, config.global, [6]);
    const without = computeReplayOutcomes(T0, flat(6), pool, config.global, [6]);
    expect(withPast[0]).toEqual(without[0]);
  });

  it("ist deterministisch", () => {
    const series = flat(6);
    expect(computeReplayOutcomes(T0, series, pool, config.global, [1, 6])).toEqual(
      computeReplayOutcomes(T0, series, pool, config.global, [1, 6]),
    );
  });
});
