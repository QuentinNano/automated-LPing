import { describe, expect, it } from "vitest";
import {
  OUTCOME_HORIZONS_HOURS,
  computeOutcomes,
  trackingIntervalSec,
  type TrackPoint,
} from "@lping/core";

const T0 = new Date("2026-07-29T12:00:00Z");

function point(hoursAfter: number, price: number, tvl = 100_000, fees24h = 2_000): TrackPoint {
  return {
    ts: new Date(T0.getTime() + hoursAfter * 3_600_000),
    priceNative: price,
    tvlUsd: tvl,
    fees24hUsd: fees24h,
    volume24hUsd: 500_000,
  };
}

function byHorizon(labels: ReturnType<typeof computeOutcomes>) {
  return new Map(labels.map((l) => [l.horizonHours, l]));
}

describe("computeOutcomes", () => {
  it("misst Preis- und TVL-Änderung je Horizont", () => {
    const points = [point(0, 1), point(1, 1.1), point(6, 1.5, 120_000), point(24, 0.9, 80_000)];
    const labels = byHorizon(computeOutcomes(T0, points));

    expect(labels.get(1)!.priceChangePct).toBeCloseTo(10);
    expect(labels.get(6)!.priceChangePct).toBeCloseTo(50);
    expect(labels.get(6)!.tvlChangePct).toBeCloseTo(20);
    expect(labels.get(24)!.priceChangePct).toBeCloseTo(-10);
    expect(labels.get(24)!.tvlChangePct).toBeCloseTo(-20);
  });

  it("erfasst den tiefsten Punkt innerhalb des Horizonts", () => {
    // Preis fällt zwischenzeitlich stark und erholt sich wieder.
    const points = [point(0, 1), point(2, 0.5), point(5, 1.05)];
    const labels = byHorizon(computeOutcomes(T0, points));
    expect(labels.get(6)!.priceChangePct).toBeCloseTo(5);
    expect(labels.get(6)!.maxDrawdownPct).toBeCloseTo(-50);
  });

  it("erkennt Rugs über Preis- oder TVL-Einbruch", () => {
    const priceRug = byHorizon(computeOutcomes(T0, [point(0, 1), point(2, 0.05)]));
    expect(priceRug.get(6)!.rugged).toBe(true);

    const tvlRug = byHorizon(
      computeOutcomes(T0, [point(0, 1, 100_000), point(2, 0.98, 2_000)]),
    );
    expect(tvlRug.get(6)!.rugged).toBe(true);

    const healthy = byHorizon(computeOutcomes(T0, [point(0, 1), point(2, 0.95)]));
    expect(healthy.get(6)!.rugged).toBe(false);
  });

  it("gewichtet den Gebührenertrag nach Zeitabstand", () => {
    // 24h-Fee-Rate konstant 2 % pro Tag; über 12 h ergibt das 1 %.
    const points = [
      point(0, 1, 100_000, 2_000),
      point(6, 1, 100_000, 2_000),
      point(12, 1, 100_000, 2_000),
    ];
    const labels = byHorizon(computeOutcomes(T0, points));
    expect(labels.get(24)!.feeYieldPct).toBeCloseTo(1, 5);
  });

  it("bleibt bei ungleichmäßigen Abständen korrekt", () => {
    // Dichtes Raster am Anfang, grobes danach — darf das Ergebnis nicht verzerren.
    const dense = [point(0, 1), point(0.25, 1), point(0.5, 1), point(12, 1)];
    const sparse = [point(0, 1), point(12, 1)];
    const a = byHorizon(computeOutcomes(T0, dense)).get(24)!.feeYieldPct!;
    const b = byHorizon(computeOutcomes(T0, sparse)).get(24)!.feeYieldPct!;
    expect(a).toBeCloseTo(b, 6);
  });

  it("weist unvollständige Abdeckung aus, statt sie zu verschweigen", () => {
    // Nur 3 Stunden Daten, aber 24-Stunden-Horizont abgefragt.
    const labels = byHorizon(computeOutcomes(T0, [point(0, 1), point(3, 1.2)]));
    const label = labels.get(24)!;
    expect(label.coveredHours).toBeCloseTo(3);
    expect(label.observations).toBe(2);
    // Der Wert existiert, aber die geringe Abdeckung ist erkennbar.
    expect(label.priceChangePct).toBeCloseTo(20);
  });

  it("ignoriert Messpunkte vor dem Entscheidungszeitpunkt", () => {
    const before: TrackPoint = {
      ts: new Date(T0.getTime() - 3_600_000),
      priceNative: 99,
      tvlUsd: 1,
      fees24hUsd: 0,
      volume24hUsd: 0,
    };
    const labels = byHorizon(computeOutcomes(T0, [before, point(0, 1), point(2, 1.1)]));
    expect(labels.get(6)!.priceChangePct).toBeCloseTo(10);
  });

  it("liefert leere Labels ohne Daten", () => {
    const labels = computeOutcomes(T0, []);
    expect(labels).toHaveLength(OUTCOME_HORIZONS_HOURS.length);
    for (const label of labels) {
      expect(label.observations).toBe(0);
      expect(label.priceChangePct).toBeNull();
      expect(label.rugged).toBe(false);
    }
  });
});

describe("trackingIntervalSec", () => {
  it("zeichnet die ersten 48 Stunden dicht auf, danach gröber", () => {
    expect(trackingIntervalSec(0)).toBe(15 * 60);
    expect(trackingIntervalSec(47)).toBe(15 * 60);
    expect(trackingIntervalSec(48)).toBe(60 * 60);
    expect(trackingIntervalSec(120)).toBe(60 * 60);
  });
});

describe("trackingIntervalSec mit Zyklus-Intervall", () => {
  it("folgt einem verkürzten Zyklus-Intervall in der Frühphase", () => {
    // Wer alle 5 Minuten läuft, will auch alle 5 Minuten messen — sonst
    // liefen zwei von drei Durchgängen ins Leere.
    expect(trackingIntervalSec(1, 5)).toBe(5 * 60);
    expect(trackingIntervalSec(47, 5)).toBe(5 * 60);
  });

  it("wird nach 48 Stunden gröber, aber nie feiner als die Frühphase", () => {
    expect(trackingIntervalSec(72, 15)).toBe(60 * 60);
    // Bei sehr dichtem Zyklus bleibt die Spätphase mindestens stündlich.
    expect(trackingIntervalSec(72, 5)).toBe(60 * 60);
    // Ein sehr grobes Wunschraster gewinnt auch spät.
    expect(trackingIntervalSec(72, 120)).toBe(120 * 60);
  });

  it("verhindert ein unsinnig kleines Raster", () => {
    expect(trackingIntervalSec(1, 0)).toBe(60);
  });
});
