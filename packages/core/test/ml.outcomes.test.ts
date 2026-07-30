import { describe, expect, it } from "vitest";
import {
  OUTCOME_HORIZONS_HOURS,
  computeOutcomes,
  effectiveFeePct,
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

  it("nutzt den Tiefstkurs einer Kerze statt des Stichprobenwerts", () => {
    // Genau der Fall, den eine Aufzeichnung im 15-Minuten-Raster nicht sieht:
    // Der Preis bricht zwischen zwei Messpunkten ein und erholt sich wieder.
    // Ohne `low` bleibt der Einbruch unsichtbar und das Label zu freundlich.
    const sampled = [point(0, 1), point(2, 0.98), point(5, 1.02)];
    expect(byHorizon(computeOutcomes(T0, sampled)).get(6)!.maxDrawdownPct).toBeCloseTo(-2);

    const withCandles = sampled.map((p, i) => (i === 1 ? { ...p, low: 0.35 } : p));
    expect(byHorizon(computeOutcomes(T0, withCandles)).get(6)!.maxDrawdownPct).toBeCloseTo(-65);
  });

  it("ignoriert einen unbrauchbaren Tiefstkurs und fällt auf den Messwert zurück", () => {
    const points = [point(0, 1), { ...point(2, 0.6), low: 0 }, point(5, 0.9)];
    expect(byHorizon(computeOutcomes(T0, points)).get(6)!.maxDrawdownPct).toBeCloseTo(-40);
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

describe("effectiveFeePct", () => {
  const base = (overrides: Partial<TrackPoint> = {}): TrackPoint => ({
    ts: T0,
    priceNative: 0.001,
    tvlUsd: 100_000,
    fees24hUsd: null,
    volume24hUsd: null,
    ...overrides,
  });

  it("bevorzugt die gemeldete Gesamtgebühr", () => {
    const point = base({
      dynamicFeePct: 3.75,
      baseFeePct: 1,
      // Auch wenn realisierte Raten vorliegen: die Meldung ist der Ist-Zustand
      // zum Messzeitpunkt, die Fenster sind Rückblicke.
      windows: { fees: { h1: 100 }, volume: { h1: 20_000 } },
      fees24hUsd: 1_000,
      volume24hUsd: 500_000,
    });
    expect(effectiveFeePct(point)).toBe(3.75);
  });

  it("nimmt das kürzeste belegte Fenster, wenn die Meldung fehlt", () => {
    // 30m: 60/1000 = 6 %; 1h: 100/20000 = 0,5 % — das kürzere gewinnt, weil es
    // dem Messintervall am nächsten liegt.
    const point = base({
      windows: { fees: { m30: 60, h1: 100 }, volume: { m30: 1_000, h1: 20_000 } },
    });
    expect(effectiveFeePct(point)).toBeCloseTo(6);
  });

  it("überspringt Fenster ohne Volumen statt durch null zu teilen", () => {
    const point = base({
      windows: { fees: { m30: 0, h1: 100 }, volume: { m30: 0, h1: 20_000 } },
    });
    expect(effectiveFeePct(point)).toBeCloseTo(0.5);
  });

  it("fällt auf die realisierte 24-Stunden-Rate zurück", () => {
    const point = base({ fees24hUsd: 12_500, volume24hUsd: 500_000 });
    // 12.500 / 500.000 = 2,5 %
    expect(effectiveFeePct(point)).toBeCloseTo(2.5);
  });

  it("nimmt zuletzt die Basisgebühr — besser als gebührenfrei zu rechnen", () => {
    expect(effectiveFeePct(base({ baseFeePct: 1 }))).toBe(1);
  });

  it("meldet null, wenn sich gar keine Rate bestimmen lässt", () => {
    // Kein Wert vortäuschen: die Simulation darf dann keine Gebühren buchen.
    expect(effectiveFeePct(base())).toBeNull();
    expect(effectiveFeePct(base({ dynamicFeePct: 0, baseFeePct: 0 }))).toBeNull();
  });

  it("bleibt für Messpunkte von vor der Schema-Erweiterung nutzbar", () => {
    // Alte Zeilen haben weder dynamicFeePct noch windows — die realisierte
    // 24-Stunden-Rate trägt sie trotzdem.
    const legacy: TrackPoint = {
      ts: T0,
      priceNative: 0.001,
      tvlUsd: 100_000,
      fees24hUsd: 2_000,
      volume24hUsd: 400_000,
    };
    expect(effectiveFeePct(legacy)).toBeCloseTo(0.5);
  });
});
