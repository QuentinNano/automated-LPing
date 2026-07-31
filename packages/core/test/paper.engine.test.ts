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
    feePct: 1,
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
    feePct: 1,
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
    // Der Preis fällt schrittweise unter die Range — langsam genug, dass keine
    // Sturz-Regel greift, weit genug, dass die Position ausblutet.
    let crash = tickPaperPosition(
      state,
      tick({ priceInSol: 0.9 }),
      config.presets["degen"]!,
      config.global,
    );
    for (let i = 2; crash.closeReason === null && i <= 40; i++) {
      crash = tickPaperPosition(
        crash.state,
        tick({ priceInSol: 0.9 ** i, at: new Date(T0.getTime() + i * 30 * 60_000) }),
        config.presets["degen"]!,
        config.global,
      );
    }
    expect(crash.valuation.pnlPct).toBeLessThan(0);
    expect(crash.closeReason).not.toBeNull();
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

  it("hält eine noch nicht befüllte Kauforder offen, statt sie sofort zu schließen", () => {
    // Der Kernfall: Eine quote_only-Position liegt per Konstruktion unterhalb
    // des aktiven Bins und wartet auf Befüllung — das ist der Normalzustand,
    // kein Fehlzustand. Wird sie hier geschlossen, verdient Degen nie eine
    // Gebühr und der Preset-Vergleich misst nur die Eröffnungskosten.
    const waiting = tickPaperPosition(
      openDegen(),
      tick({ priceInSol: 3 }),
      config.presets["degen"]!,
      config.global,
    );
    expect(waiting.valuation.inRange).toBe(false);
    expect(waiting.state.rangeReached).toBe(false);
    expect(waiting.closeReason).toBeNull();
  });

  it("schließt erst, nachdem der Markt die Range erreicht hatte und sie verließ", () => {
    // Preis fällt in die Range (Befüllung) …
    const filled = tickPaperPosition(
      openDegen(),
      tick({ priceInSol: 0.95 }),
      config.presets["degen"]!,
      config.global,
    );
    expect(filled.state.rangeReached).toBe(true);
    expect(filled.closeReason).toBeNull();

    // … und läuft anschließend darüber hinaus: jetzt ist die Position tot.
    const left = tickPaperPosition(
      filled.state,
      // Innerhalb der Ertrags-Karenzzeit (feeStallHours), damit hier wirklich
      // die Range-Regel greift und nicht der Ertrags-Exit vorher zuschlägt.
      tick({ priceInSol: 3, at: new Date(T0.getTime() + 3_600_000) }),
      config.presets["degen"]!,
      config.global,
    );
    expect(left.closeReason).toBe("out_of_range");
  });

  it("erkennt Befüllung auch, wenn der Preis die Range in einem Schritt durchläuft", () => {
    // Zwischen zwei Messpunkten kann der Preis die Range komplett durchfallen.
    // Die Position ist dann befüllt und wieder außerhalb — über `inRange`
    // allein bliebe sie fälschlich als "nie erreicht" markiert.
    const crashed = tickPaperPosition(
      openDegen(),
      tick({ priceInSol: 0.01 }),
      config.presets["degen"]!,
      config.global,
    );
    expect(crashed.valuation.inRange).toBe(false);
    expect(crashed.state.rangeReached).toBe(true);
    expect(valuePosition(crashed.state, 0.5).tokenAmount).toBeGreaterThan(0);
  });

  it("Presets mit Rebalancing steigen nicht wegen der Range aus", () => {
    const konservativ = tickPaperPosition(
      openKonservativ(),
      tick({ priceInSol: 2.2, poolVolume24hUsd: 15_000_000 }),
      config.presets["konservativ"]!,
      config.global,
    );
    expect(konservativ.closeReason).toBeNull();
    // Nicht mehr "tot außerhalb der Range liegen bleiben": die Position wird
    // nachzentriert und ist danach wieder aktiv.
    expect(konservativ.state.rebalanceCount).toBe(1);
    expect(konservativ.valuation.inRange).toBe(true);
  });
});

describe("Rebalancing", () => {
  const konservativ = config.presets["konservativ"]!;

  /**
   * Ein Pool, dessen Ertragskraft den Rebalance zweifelsfrei trägt.
   *
   * Die Trigger-Tests prüfen die Geometrie — Puffer, Cooldown, Tageslimit. Ob
   * sich ein Rebalance *lohnt*, ist eine andere Frage, und sie hat ihren eigenen
   * Test. Ohne diese Trennung hinge jeder Trigger-Test an einer EV-Grenzlage und
   * schlüge bei jeder Kalibrierung der Kostenannahmen um.
   */
  const richTick = (overrides: Partial<MarketTick> = {}): MarketTick =>
    tick({ poolVolume24hUsd: 15_000_000, ...overrides });

  it("zentriert nach, sobald der Preis den Puffer verlässt", () => {
    const before = openKonservativ();
    const after = tickPaperPosition(before, richTick({ priceInSol: 2.2 }), konservativ, config.global);

    expect(after.state.rebalanceCount).toBe(1);
    expect(after.state.lastRebalanceMs).not.toBeNull();
    // Die Range liegt jetzt um den neuen Preis statt um den Eröffnungspreis.
    expect(after.state.minBinId).toBeGreaterThan(before.minBinId);
    expect(after.state.maxBinId).toBeGreaterThan(before.maxBinId);
  });

  it("bucht Kosten und Transaktionen — Rebalance ist nicht gratis", () => {
    const before = openKonservativ();
    const after = tickPaperPosition(before, richTick({ priceInSol: 2.2 }), konservativ, config.global);

    expect(after.state.costsSol).toBeGreaterThan(before.costsSol);
    // Ein Ablauf (claim/remove/resize/add), nicht Schließen und Neueröffnen.
    expect(after.state.txCount).toBe(before.txCount + 2);
  });

  it("rührt eine Position innerhalb des Puffers nicht an", () => {
    const before = openKonservativ();
    const after = tickPaperPosition(before, tick({ priceInSol: 1.05 }), konservativ, config.global);
    expect(after.state.rebalanceCount).toBe(0);
    expect(after.state.minBinId).toBe(before.minBinId);
  });

  it("hält den Cooldown ein, statt in Seitwärtsphasen zu zappeln", () => {
    const first = tickPaperPosition(
      openKonservativ(),
      richTick({ priceInSol: 2.2 }),
      konservativ,
      config.global,
    );
    expect(first.state.rebalanceCount).toBe(1);

    // Dazwischen verdient die Position im aktiven Bin. Das ist nicht Beiwerk:
    // Die EV-Prüfung schätzt die künftige Zeit in Range aus der bisherigen, und
    // eine Position, die nie in Range war, bekommt zu Recht kein Budget für den
    // nächsten Rebalance — das wäre Nachjagen, kein Nachzentrieren.
    const earning = tickPaperPosition(
      first.state,
      richTick({ priceInSol: 2.2, at: new Date(T0.getTime() + 2 * 3_600_000) }),
      konservativ,
      config.global,
    );
    // cooldownMin = 240 → eine Stunde nach dem ersten Rebalance darf noch nicht
    // erneut nachzentriert werden, auch wenn der Preis weiterläuft.
    const tooSoon = tickPaperPosition(
      earning.state,
      richTick({ priceInSol: 4.5, at: new Date(T0.getTime() + 3 * 3_600_000) }),
      konservativ,
      config.global,
    );
    expect(tooSoon.state.rebalanceCount).toBe(1);

    const later = tickPaperPosition(
      earning.state,
      richTick({ priceInSol: 4.5, at: new Date(T0.getTime() + 6 * 3_600_000) }),
      konservativ,
      config.global,
    );
    expect(later.state.rebalanceCount).toBe(2);
  });

  it("unterlässt den Rebalance, wenn er sich nicht rechnet", () => {
    // Kaum Volumen → der erwartete Zusatzertrag deckt die Kosten nicht,
    // minEvFactor (3) erst recht nicht.
    const after = tickPaperPosition(
      openKonservativ(),
      tick({ priceInSol: 1.3, poolVolume24hUsd: 500 }),
      konservativ,
      config.global,
    );
    expect(after.state.rebalanceCount).toBe(0);
  });

  it("rebalanciert nicht, wenn die Position ohnehin geschlossen gehört", () => {
    // Abwärts-Rebalance ist zugleich ein Stop-Loss-Check: nie in einen
    // fallenden Preis nachzentrieren (KONZEPT.md 8.2).
    const crash = tickPaperPosition(
      openKonservativ(),
      tick({ priceInSol: 0.4 }),
      konservativ,
      config.global,
    );
    expect(crash.closeReason).toBe("stop_loss");
    expect(crash.state.rebalanceCount).toBe(0);
  });

  it("Degen rebalanciert nie — Positionen werden geschlossen, nicht nachgeführt", () => {
    const after = tickPaperPosition(
      openDegen(),
      tick({ priceInSol: 0.8 }),
      config.presets["degen"]!,
      config.global,
    );
    expect(after.state.rebalanceCount).toBe(0);
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

describe("Gebührenmodell", () => {
  const degen = config.presets["degen"]!;

  /**
   * Gesamter Gebührenertrag eines Ticks. Bewusst claimed + unclaimed: Ein
   * Claim nullt `feesUnclaimedSol`, sodass ein höherer Ertrag als 0 erschiene.
   */
  const earned = (state: PaperPositionState) => state.feesClaimedSol + state.feesUnclaimedSol;

  /** Eine Position mit gegebener Strategie am Preis 1, danach ein Tick in Range. */
  function feesFor(strategy: "Spot" | "Curve" | "BidAsk", binCount = 30): number {
    const preset = {
      ...degen,
      strategy: { type: strategy, sided: "balanced" as const },
      binRange: { min: binCount, max: binCount },
    };
    const state = openPaperPosition({
      preset,
      global: config.global,
      binStep: 100,
      price: 1,
      depositSol: 1,
      feePct: 1,
      at: T0,
    });
    return earned(tickPaperPosition(state, tick({ priceInSol: 1 }), preset, config.global).state);
  }

  it("unterscheidet die Strategietypen — Konzentration am aktiven Bin zahlt sich aus", () => {
    // Über den bloßen TVL-Anteil gerechnet wären alle drei identisch. Genau das
    // machte strategy.type für die Optimierung unbrauchbar.
    const curve = feesFor("Curve");
    const spot = feesFor("Spot");
    const bidAsk = feesFor("BidAsk");

    expect(curve).toBeGreaterThan(spot);
    expect(spot).toBeGreaterThan(bidAsk);
  });

  it("belohnt engere Ranges bei gleichem Einsatz", () => {
    expect(feesFor("Spot", 10)).toBeGreaterThan(feesFor("Spot", 60));
  });

  it("verdient nichts, wenn der aktive Bin außerhalb der Position liegt", () => {
    const state = openDegen();
    // Preis oberhalb der Range: kein Bin der Position ist aktiv.
    const result = tickPaperPosition(state, tick({ priceInSol: 2 }), degen, config.global);
    expect(earned(result.state)).toBe(0);
  });

  it("zieht den Protokollanteil ab, bevor LPs verteilt wird", () => {
    const state = openDegen();
    const standard = earned(
      tickPaperPosition(state, tick({ priceInSol: 0.95, protocolFeePct: 10 }), degen, config.global)
        .state,
    );
    const launchPool = earned(
      tickPaperPosition(state, tick({ priceInSol: 0.95, protocolFeePct: 20 }), degen, config.global)
        .state,
    );

    // 20 % Protokollanteil lässt dem LP 80/90 dessen, was 10 % übrig lassen.
    expect(launchPool).toBeCloseTo(standard * (80 / 90), 9);
  });

  it("nimmt ohne Angabe den Standard-Protokollanteil an, nicht null", () => {
    const state = openDegen();
    const implicit = earned(
      tickPaperPosition(state, tick({ priceInSol: 0.95 }), degen, config.global).state,
    );
    const explicit = earned(
      tickPaperPosition(state, tick({ priceInSol: 0.95, protocolFeePct: 10 }), degen, config.global)
        .state,
    );
    expect(implicit).toBeCloseTo(explicit, 12);
  });

  it("skaliert mit der angenommenen Bin-Breite der übrigen LPs", () => {
    const state = openDegen();
    const fees = (poolLiquidityBins: number) =>
      earned(
        tickPaperPosition(state, tick({ priceInSol: 0.95 }), degen, {
          ...config.global,
          paper: { ...config.global.paper, poolLiquidityBins },
        }).state,
      );

    // Liegt die Fremdliquidität breiter, ist im aktiven Bin weniger davon —
    // der eigene Anteil steigt.
    expect(fees(200)).toBeGreaterThan(fees(20));
  });
});

describe("Kerzen-Extrema statt Schlusskurs", () => {
  const balanced = config.presets["balanced"]!;

  function openBalanced(price = 1): PaperPositionState {
    return openPaperPosition({
      preset: balanced,
      global: config.global,
      binStep: 50,
      price,
      depositSol: 3,
      feePct: 1,
      volatilityPctDaily: 40,
      at: T0,
    });
  }

  it("zählt nur den Anteil des Intervalls, der in der Range lag", () => {
    const state = openBalanced();
    const oben = state.bins[state.bins.length - 1]!.price;

    // Schlusskurs in der Range, das Hoch weit darüber: Die Position war einen
    // Teil des Intervalls draußen. Über Schlusskurse gemessen zählte sie voll.
    const mitDocht = tickPaperPosition(
      state,
      tick({ priceInSol: 1, priceLow: 1, priceHigh: oben * 1.5 }),
      balanced,
      config.global,
    );
    const ohneDocht = tickPaperPosition(state, tick({ priceInSol: 1 }), balanced, config.global);

    expect(ohneDocht.valuation.timeInRangePct).toBeCloseTo(100, 6);
    expect(mitDocht.valuation.timeInRangePct).toBeLessThan(100);
    expect(mitDocht.valuation.timeInRangePct).toBeGreaterThan(0);
  });

  it("ohne Extrema bleibt das Verhalten exakt das frühere", () => {
    const state = openBalanced();
    const ohne = tickPaperPosition(state, tick({ priceInSol: 0.97 }), balanced, config.global);
    const gleich = tickPaperPosition(
      state,
      tick({ priceInSol: 0.97, priceLow: 0.97, priceHigh: 0.97 }),
      balanced,
      config.global,
    );
    expect(gleich.valuation.timeInRangePct).toBeCloseTo(ohne.valuation.timeInRangePct, 12);
    expect(gleich.valuation.pnlSol).toBeCloseTo(ohne.valuation.pnlSol, 12);
  });

  it("stoppt am Tief des Intervalls aus, auch wenn der Schlusskurs sich erholt hat", () => {
    // Ein Stop-Loss ist eine Auslösung, kein Endstandsvergleich. Über
    // Schlusskurse gemessen überlebte eine Position, die zwischendurch tief
    // unter der Schwelle lag — der einzige Notausgang löste zu selten aus.
    const state = openBalanced();

    const nurSchluss = tickPaperPosition(
      state,
      tick({ priceInSol: 0.99 }),
      balanced,
      config.global,
    );
    expect(nurSchluss.closeReason).toBeNull();

    const mitTief = tickPaperPosition(
      state,
      tick({ priceInSol: 0.99, priceHigh: 1, priceLow: 0.35 }),
      balanced,
      config.global,
    );
    expect(mitTief.closeReason).not.toBeNull();
    // Bewertet wird dort, wo ausgestiegen wurde — nicht am freundlicheren Schluss.
    expect(mitTief.valuation.pnlPct).toBeLessThan(nurSchluss.valuation.pnlPct);
    expect(mitTief.state.lastPrice).toBe(0.35);
  });

  it("eine einseitige Position gilt als befüllt, wenn der Docht die Range erreicht", () => {
    const degenState = openDegen();
    const oben = degenState.bins[degenState.bins.length - 1]!.price;

    const nurSchluss = tickPaperPosition(
      degenState,
      tick({ priceInSol: oben * 1.02 }),
      config.presets["degen"]!,
      config.global,
    );
    expect(nurSchluss.state.rangeReached).toBe(false);

    // Der Preis fiel innerhalb des Intervalls in die Leiter und erholte sich.
    // Die Position hat den Token dann tatsächlich gekauft.
    const mitDocht = tickPaperPosition(
      degenState,
      tick({ priceInSol: oben * 1.02, priceHigh: oben * 1.02, priceLow: oben * 0.98 }),
      config.presets["degen"]!,
      config.global,
    );
    expect(mitDocht.state.rangeReached).toBe(true);
  });
});
