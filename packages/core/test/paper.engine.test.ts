import { describe, expect, it } from "vitest";
import {
  closePaperPosition,
  openPaperPosition,
  tickPaperPosition,
  valuePosition,
  type MarketTick,
  type PaperPositionState,
} from "@lping/core";
import { loadDefaultConfig } from "./builders";

const config = loadDefaultConfig();
const T0 = new Date("2026-07-29T12:00:00Z");

function tick(overrides: Partial<MarketTick> = {}): MarketTick {
  return {
    priceInSol: 1,
    poolTvlUsd: 250_000,
    poolVolume24hUsd: 1_250_000,
    poolFeePct: 1,
    solPriceUsd: 180,
    at: new Date(T0.getTime() + 3_600_000),
    ...overrides,
  };
}

function openDegen(price = 1): PaperPositionState {
  return openPaperPosition({
    preset: config.presets["degen"]!,
    global: config.global,
    binStep: 100,
    price,
    depositSol: 1,
    at: T0,
  });
}

function openKonservativ(price = 1): PaperPositionState {
  return openPaperPosition({
    preset: config.presets["konservativ"]!,
    global: config.global,
    binStep: 20,
    price,
    depositSol: 1,
    at: T0,
  });
}

describe("openPaperPosition", () => {
  it("Degen (quote_only) startet zu 100 % in SOL und ohne Swap-Kosten", () => {
    const state = openDegen();
    const valuation = valuePosition(state, 1);
    expect(valuation.tokenAmount).toBe(0);
    expect(valuation.solAmount).toBeCloseTo(1);
    expect(state.entryTokenShare).toBe(0);
    // Nur eine Transaktion (Open), kein Swap.
    expect(state.txCount).toBe(1);
    expect(state.costsSol).toBeCloseTo(config.global.paper.costs.priorityFeeSol);
  });

  it("Konservativ (balanced) hält beide Seiten und zahlt Swap-Kosten", () => {
    const state = openKonservativ();
    const valuation = valuePosition(state, 1);
    expect(valuation.tokenAmount).toBeGreaterThan(0);
    expect(valuation.solAmount).toBeGreaterThan(0);
    expect(state.entryTokenShare).toBeGreaterThan(0);
    expect(state.costsSol).toBeGreaterThan(config.global.paper.costs.priorityFeeSol);
    expect(state.txCount).toBe(2);
  });

  it("Position startet leicht negativ (Einstiegskosten sind sofort real)", () => {
    const valuation = valuePosition(openDegen(), 1);
    expect(valuation.pnlSol).toBeLessThan(0);
    expect(valuation.pnlSol).toBeCloseTo(-config.global.paper.costs.priorityFeeSol, 6);
  });
});

describe("tickPaperPosition", () => {
  it("akkumuliert Fees nur innerhalb der Range", () => {
    const state = openDegen();
    // Preis fällt in die Range hinein → Fees fließen.
    const inRange = tickPaperPosition(state, tick({ priceInSol: 0.95 }), config.presets["degen"]!, config.global);
    expect(inRange.valuation.inRange).toBe(true);
    expect(inRange.state.feesUnclaimedSol).toBeGreaterThan(0);

    // Preis weit über der Range → keine weiteren Fees.
    const before = inRange.state.feesUnclaimedSol;
    const outOfRange = tickPaperPosition(
      inRange.state,
      tick({ priceInSol: 5, at: new Date(T0.getTime() + 7_200_000) }),
      config.presets["degen"]!,
      config.global,
    );
    expect(outOfRange.valuation.inRange).toBe(false);
    expect(outOfRange.state.feesUnclaimedSol).toBeCloseTo(before);
  });

  it("berücksichtigt den Sicherheitsabschlag auf den Fee-Anteil", () => {
    const state = openDegen();
    const withHaircut = tickPaperPosition(state, tick({ priceInSol: 0.95 }), config.presets["degen"]!, config.global);
    const noHaircut = tickPaperPosition(
      state,
      tick({ priceInSol: 0.95 }),
      config.presets["degen"]!,
      { ...config.global, paper: { ...config.global.paper, feeShareHaircutPct: 0 } },
    );
    expect(withHaircut.state.feesUnclaimedSol).toBeLessThan(noHaircut.state.feesUnclaimedSol);
    expect(withHaircut.state.feesUnclaimedSol).toBeCloseTo(noHaircut.state.feesUnclaimedSol * 0.7, 9);
  });

  it("claimt nach Intervall und bucht Konvertierungskosten", () => {
    let state = openDegen();
    // Viel Volumen, damit der Claim die Kostenschwelle überschreitet.
    const busy = tick({ priceInSol: 0.95, poolVolume24hUsd: 500_000_000 });
    const result = tickPaperPosition(state, busy, config.presets["degen"]!, config.global);
    state = result.state;
    expect(state.feesClaimedSol).toBeGreaterThan(0);
    expect(state.feesUnclaimedSol).toBe(0);
    // Open (1 tx) + Claim + Konvertierungs-Swap (2 tx)
    expect(state.txCount).toBe(3);
  });

  it("claimt nicht, wenn der Betrag die Transaktionskosten nicht lohnt", () => {
    const state = openDegen();
    const quiet = tick({ priceInSol: 0.95, poolVolume24hUsd: 100 });
    const result = tickPaperPosition(state, quiet, config.presets["degen"]!, config.global);
    expect(result.state.feesClaimedSol).toBe(0);
    expect(result.state.feesUnclaimedSol).toBeGreaterThan(0);
  });

  it("misst Time-in-Range über die Laufzeit", () => {
    let state = openDegen();
    state = tickPaperPosition(state, tick({ priceInSol: 0.95 }), config.presets["degen"]!, config.global).state;
    const out = tickPaperPosition(
      state,
      tick({ priceInSol: 5, at: new Date(T0.getTime() + 7_200_000) }),
      config.presets["degen"]!,
      config.global,
    );
    // 1h in Range, 1h außerhalb
    expect(out.valuation.timeInRangePct).toBeCloseTo(50, 0);
  });
});

describe("Exit-Bedingungen", () => {
  it("Stop-Loss bei Preisverfall", () => {
    const state = openDegen();
    const crash = tickPaperPosition(
      state,
      tick({ priceInSol: 0.5 }),
      config.presets["degen"]!,
      config.global,
    );
    expect(crash.valuation.pnlPct).toBeLessThan(-config.presets["degen"]!.stopLossPct);
    expect(crash.closeReason).toBe("stop_loss");
  });

  it("Max-Haltezeit greift auch bei ruhigem Markt", () => {
    const state = openDegen();
    const late = tickPaperPosition(
      state,
      tick({ priceInSol: 0.99, at: new Date(T0.getTime() + 25 * 3_600_000) }),
      config.presets["degen"]!,
      config.global,
    );
    expect(late.closeReason).toBe("max_hold_time");
  });

  it("out_of_range schließt nur Presets ohne Rebalancing", () => {
    const degen = tickPaperPosition(
      openDegen(),
      tick({ priceInSol: 3 }),
      config.presets["degen"]!,
      config.global,
    );
    expect(degen.closeReason).toBe("out_of_range");

    // Konservativ rebalanced → kein Zwangsausstieg wegen Range.
    // (binStep 20 über ~65 Bins ergibt eine deutlich breitere Range als Degen,
    // deshalb muss der Preis weiter laufen, um sie zu verlassen.)
    const konservativ = tickPaperPosition(
      openKonservativ(),
      tick({ priceInSol: 1.3 }),
      config.presets["konservativ"]!,
      config.global,
    );
    expect(konservativ.valuation.inRange).toBe(false);
    expect(konservativ.closeReason).toBeNull();
  });
});

describe("HODL-Benchmark & Close", () => {
  it("quote_only vergleicht gegen gehaltenes SOL (Benchmark preisunabhängig)", () => {
    const state = openDegen();
    const valuation = valuePosition(state, 0.5);
    expect(valuation.hodlValueSol).toBeCloseTo(1);
    // Position hat bei fallendem Preis Token gekauft → schlechter als SOL halten.
    expect(valuation.vsHodlSol).toBeLessThan(0);
  });

  it("balanced-Benchmark folgt der Preisbewegung", () => {
    const state = openKonservativ();
    const up = valuePosition(state, 1.2);
    expect(up.hodlValueSol).toBeGreaterThan(1);
    const down = valuePosition(state, 0.8);
    expect(down.hodlValueSol).toBeLessThan(1);
  });

  it("Close bucht Verkaufskosten auf den Token-Rest und realisiert Fees", () => {
    let state = openDegen();
    state = tickPaperPosition(state, tick({ priceInSol: 0.95 }), config.presets["degen"]!, config.global).state;
    const unclaimed = state.feesUnclaimedSol;
    expect(unclaimed).toBeGreaterThan(0);

    const closed = closePaperPosition(state, 0.95, config.global);
    expect(closed.state.feesUnclaimedSol).toBe(0);
    expect(closed.state.feesClaimedSol).toBeCloseTo(unclaimed);
    expect(closed.state.costsSol).toBeGreaterThan(state.costsSol);
    expect(closed.proceedsSol).toBeCloseTo(closed.valuation.totalValueSol);
    expect(closed.realizedPnlSol).toBeCloseTo(closed.proceedsSol - state.depositSol);
  });

  it("Close ohne Token-Bestand verursacht nur eine Transaktion", () => {
    const state = openDegen();
    const closed = closePaperPosition(state, 1, config.global);
    expect(closed.state.txCount).toBe(state.txCount + 1);
  });
});
