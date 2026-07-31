import { describe, expect, it } from "vitest";
import { trailingDailyRate } from "@lping/db";

/**
 * Die Glättung, die den Replay von einer einzelnen Kerze löst.
 *
 * `loadHistory` rechnet jede Kerze mit `1440 / Fensterminuten` auf eine
 * Tagesrate hoch — für den Gebühren-Akkrual über genau dieses Intervall ist das
 * richtig. Für die **Projektion** des Rebalance-EV über Stunden ist es falsch:
 * Eine Fünf-Minuten-Spitze wird dort zur Dauerannahme. Diese Funktion liefert
 * die Gegengröße.
 */
const FUENF_MIN = 5 * 60_000;
const T0 = Date.parse("2026-07-29T12:00:00Z");

function reihe(werte: (number | null)[], stepMs = FUENF_MIN) {
  return werte.map((value, i) => ({ ts: new Date(T0 + i * stepMs), value }));
}

describe("trailingDailyRate", () => {
  it("rechnet eine konstante Reihe auf dieselbe Tagesrate hoch wie die Einzelkerze", () => {
    const raten = trailingDailyRate(reihe([2_000, 2_000, 2_000]), FUENF_MIN);
    // 2.000 USD je 5 Minuten sind 288 × 2.000 am Tag — egal über wie viele
    // Kerzen gemittelt wird.
    for (const rate of raten) expect(rate).toBeCloseTo(2_000 * 288, 6);
  });

  it("glättet eine Spitze, statt ihr zu folgen", () => {
    const raten = trailingDailyRate(reihe([2_000, 2_000, 6_000]), FUENF_MIN);
    // Einzelkerze wäre 6.000 × 288 = 1.728.000; der Mittelwert ist 960.000.
    expect(raten[2]).toBeCloseTo(((2_000 + 2_000 + 6_000) / 3) * 288, 6);
    expect(raten[2]!).toBeLessThan(6_000 * 288);
  });

  it("rechnet am Reihenanfang über die tatsächlich belegte Zeit hoch", () => {
    // Sonst sähe der Beginn jeder Zeitreihe systematisch ruhiger aus, als er
    // war — die ersten Punkte hätten nur einen Bruchteil eines Tages im Nenner.
    const raten = trailingDailyRate(reihe([5_000]), FUENF_MIN);
    expect(raten[0]).toBeCloseTo(5_000 * 288, 6);
  });

  it("vergisst, was älter als 24 Stunden ist", () => {
    // 300 Kerzen à 5 Minuten = 25 Stunden. Die erste Kerze ist am Ende raus.
    const werte = [1_000_000, ...Array.from({ length: 299 }, () => 1_000)];
    const raten = trailingDailyRate(reihe(werte), FUENF_MIN);
    expect(raten[0]).toBeCloseTo(1_000_000 * 288, 6);
    expect(raten[299]).toBeCloseTo(1_000 * 288, 6);
  });

  it("liefert null, wo keine einzige Menge belegt ist", () => {
    // Eine erfundene Null läse die Projektion als "kein Volumen".
    expect(trailingDailyRate(reihe([null, null]), FUENF_MIN)).toEqual([null, null]);
    expect(trailingDailyRate([], FUENF_MIN)).toEqual([]);
  });

  it("überspringt Lücken, statt sie als Nullvolumen zu zählen", () => {
    const raten = trailingDailyRate(reihe([2_000, null, 2_000]), FUENF_MIN);
    expect(raten[2]).toBeCloseTo(2_000 * 288, 6);
  });
});
