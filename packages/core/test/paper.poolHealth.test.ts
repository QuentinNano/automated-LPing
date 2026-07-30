import { describe, expect, it } from "vitest";
import {
  evaluatePoolExit,
  poolFeeRatePctPerDay,
  recordObservation,
  type ExitConfig,
  type PoolObservation,
} from "@lping/core";

const T0 = Date.parse("2026-07-29T12:00:00Z");

const exit: ExitConfig = {
  priceCrashPct: 20,
  priceWindowMin: 30,
  tvlDrainPct: 30,
  tvlWindowMin: 60,
  feeCollapsePct: 70,
  feeStallHours: 6,
  feeStallMinPctPerDay: 0.3,
};

function obs(minutes: number, overrides: Partial<PoolObservation> = {}): PoolObservation {
  return {
    atMs: T0 + minutes * 60_000,
    priceInSol: 1,
    tvlUsd: 200_000,
    feeRatePctPerDay: 10,
    feesTotalSol: 0,
    ...overrides,
  };
}

/** Gesunder Verlauf: konstanter Preis, konstanter TVL, laufender Ertrag. */
function healthy(count: number, stepMin = 15): PoolObservation[] {
  return Array.from({ length: count }, (_, i) =>
    obs(i * stepMin, { feesTotalSol: i * 0.01 }),
  );
}

const base = {
  exit,
  entryFeeRatePctPerDay: 10,
  depositSol: 3,
  ageMs: 6 * 3_600_000,
  rangeReached: true,
};

describe("evaluatePoolExit", () => {
  it("lässt eine gesunde Position in Ruhe", () => {
    expect(evaluatePoolExit({ ...base, history: healthy(8) })).toBeNull();
  });

  it("urteilt nicht auf einer einzelnen Beobachtung", () => {
    // Ohne Vergleichspunkt gibt es keine Veränderung zu beurteilen — und ein
    // Ausstieg auf Basis einer einzelnen Momentaufnahme wäre geraten.
    expect(evaluatePoolExit({ ...base, history: [obs(0)] })).toBeNull();
  });

  it("erkennt den Preissturz am Fensterhoch, nicht am Einstieg", () => {
    // Der Preis ist erst gestiegen und stürzt dann ab. Gegen den Einstieg
    // gemessen wäre das kein Einbruch — gegen das Hoch sehr wohl, und die
    // Position hält jetzt Token, die sie oben gekauft hat.
    const history = [obs(0), obs(15, { priceInSol: 2 }), obs(30, { priceInSol: 1.5 })];
    expect(evaluatePoolExit({ ...base, history })).toBe("price_crash");
  });

  it("ignoriert einen Sturz, der außerhalb des Fensters liegt", () => {
    const history = [
      obs(0, { priceInSol: 2, feesTotalSol: 0 }),
      obs(60, { priceInSol: 1, feesTotalSol: 0.4 }),
      obs(75, { priceInSol: 1, feesTotalSol: 0.5 }),
    ];
    expect(evaluatePoolExit({ ...base, history })).toBeNull();
  });

  it("steigt aus, wenn Liquidität abfließt", () => {
    const history = [
      obs(0, { tvlUsd: 200_000 }),
      obs(30, { tvlUsd: 160_000 }),
      obs(45, { tvlUsd: 120_000 }),
    ];
    expect(evaluatePoolExit({ ...base, history })).toBe("tvl_drain");
  });

  it("steigt aus, wenn die Ertragskraft des Pools zusammenbricht", () => {
    const history = [
      obs(0, { feeRatePctPerDay: 10 }),
      obs(15, { feeRatePctPerDay: 2 }),
      obs(30, { feeRatePctPerDay: 1 }),
      obs(45, { feeRatePctPerDay: 1 }),
    ];
    expect(evaluatePoolExit({ ...base, history })).toBe("fee_collapse");
  });

  it("lässt eine einzelne ruhige Messung durchgehen", () => {
    // Die Gebührenrate schwankt auf kurzen Fenstern stark. Der Median schützt
    // davor, eine funktionierende Position wegen einer stillen Viertelstunde zu
    // schließen — ein Einzelwert täte genau das.
    const history = [
      obs(0, { feesTotalSol: 0 }),
      obs(15, { feeRatePctPerDay: 0.5, feesTotalSol: 0.1 }),
      obs(30, { feesTotalSol: 0.2 }),
      obs(45, { feesTotalSol: 0.3 }),
    ];
    expect(evaluatePoolExit({ ...base, history })).toBeNull();
  });

  it("steigt aus, wenn die Position selbst nichts mehr verdient", () => {
    // Der Pool ist gesund — nur unsere Range liegt daneben. `fee_collapse` sieht
    // das nicht, `fee_stall` schon.
    const history = Array.from({ length: 30 }, (_, i) => obs(i * 15, { feesTotalSol: 0.05 }));
    expect(evaluatePoolExit({ ...base, history, ageMs: 8 * 3_600_000 })).toBe("fee_stall");
  });

  it("verschont eine einseitige Position, die noch auf Befüllung wartet", () => {
    // Eine quote_only-Position liegt beim Eröffnen bewusst außerhalb der Range.
    // Dass sie nichts verdient, ist dort kein Befund, sondern der Plan.
    const history = Array.from({ length: 30 }, (_, i) => obs(i * 15, { feesTotalSol: 0 }));
    expect(
      evaluatePoolExit({ ...base, history, ageMs: 8 * 3_600_000, rangeReached: false }),
    ).toBeNull();
  });

  it("wartet die Karenzzeit ab, bevor es Ertrag beurteilt", () => {
    const history = Array.from({ length: 8 }, (_, i) => obs(i * 15, { feesTotalSol: 0 }));
    expect(evaluatePoolExit({ ...base, history, ageMs: 2 * 3_600_000 })).toBeNull();
  });

  it("stellt Risiko-Exits vor Ertrags-Exits", () => {
    // Beides trifft zu: Der Ertrag ist versiegt UND der Preis stürzt. Wer nicht
    // mehr aussteigen kann, hat kein Ertragsproblem mehr — der Sturz gewinnt.
    const history = [
      ...Array.from({ length: 28 }, (_, i) => obs(i * 15, { feesTotalSol: 0 })),
      obs(28 * 15, { priceInSol: 0.5, feesTotalSol: 0 }),
    ];
    expect(evaluatePoolExit({ ...base, history, ageMs: 8 * 3_600_000 })).toBe("price_crash");
  });

  it("ist ohne Einstiegs-Referenz beim Ertrag still statt zu raten", () => {
    const history = [
      obs(0, { feeRatePctPerDay: 0 }),
      obs(15, { feeRatePctPerDay: 0 }),
      obs(30, { feeRatePctPerDay: 0, feesTotalSol: 1 }),
    ];
    expect(
      evaluatePoolExit({ ...base, history, entryFeeRatePctPerDay: 0, ageMs: 3_600_000 }),
    ).toBeNull();
  });
});

describe("recordObservation", () => {
  it("verwirft, was keine Regel mehr braucht", () => {
    let history: PoolObservation[] = [];
    for (let i = 0; i < 60; i++) history = recordObservation(history, obs(i * 15), exit);

    // Das längste Fenster ist feeStallHours = 6 h → 24 Punkte im 15-min-Raster.
    const spanMin = (history[history.length - 1]!.atMs - history[0]!.atMs) / 60_000;
    expect(spanMin).toBeLessThanOrEqual(6 * 60);
    expect(history.length).toBeLessThanOrEqual(25);
  });

  it("deckelt die Länge auch bei sehr feinem Raster", () => {
    // Der Zustand wird als JSON persistiert — er darf unter keinem Raster
    // unbegrenzt wachsen.
    let history: PoolObservation[] = [];
    for (let i = 0; i < 5_000; i++) {
      history = recordObservation(history, obs(i * 0.05), exit);
    }
    expect(history.length).toBeLessThanOrEqual(96);
  });

  it("behält die jüngste Beobachtung immer", () => {
    const history = recordObservation([obs(0)], obs(10_000), exit);
    expect(history[history.length - 1]!.atMs).toBe(T0 + 10_000 * 60_000);
  });
});

describe("poolFeeRatePctPerDay", () => {
  it("rechnet Volumen und Gebührensatz in eine TVL-bezogene Rate um", () => {
    // 1 Mio $ Umsatz, 1 % Gebühr, 200 k$ TVL → 10 000 $/Tag auf 200 k$ = 5 %.
    expect(poolFeeRatePctPerDay(1_000_000, 1, 200_000)).toBeCloseTo(5, 6);
  });

  it("ist 0 statt unendlich, wenn eine Größe fehlt", () => {
    expect(poolFeeRatePctPerDay(1_000_000, 1, 0)).toBe(0);
    expect(poolFeeRatePctPerDay(0, 1, 200_000)).toBe(0);
    expect(poolFeeRatePctPerDay(1_000_000, 0, 200_000)).toBe(0);
  });
});
