import type { GlobalConfig, PresetConfig } from "../config/schema";
import { applyPriceMove, isInRange, openBins, totalsOf } from "./bins";
import type {
  MarketTick,
  PaperCloseReason,
  PaperPositionState,
  PaperTickResult,
  PaperValuation,
} from "./types";

/**
 * Paper-Trading-Engine: simuliert den Positions-Lebenszyklus auf echten
 * Marktdaten, ohne Kapitaleinsatz (KONZEPT.md Abschnitt 13, Phase 1).
 *
 * Kostenmodell — bewusst NUR On-Chain-Kosten:
 * Priority Fees je Transaktion und Slippage/Preis-Impact je Swap. Positions-Rent
 * ist erstattungsfähig und damit gebundenes Kapital, kein Aufwand.
 * Infrastrukturkosten (VPS, RPC-Tarife) bleiben außen vor: Sie sind monatlicher
 * Fixaufwand, keiner Position zurechenbar, und würden den Preset-Vergleich
 * verzerren statt ihn zu schärfen.
 */

export interface OpenPaperPositionParams {
  preset: PresetConfig;
  global: GlobalConfig;
  binStep: number;
  /** Token-Preis in SOL zum Eröffnungszeitpunkt. */
  price: number;
  /** Einsatz in SOL (vor Kosten). */
  depositSol: number;
  at: Date;
}

export function openPaperPosition(params: OpenPaperPositionParams): PaperPositionState {
  const { preset, global, binStep, price, depositSol, at } = params;
  const binCount = Math.round((preset.binRange.min + preset.binRange.max) / 2);

  const opened = openBins({
    price,
    binStep,
    binCount,
    strategy: preset.strategy.type,
    sided: preset.strategy.sided,
    depositSol,
  });

  // Kosten des Einstiegs: eine Transaktion + Swap-Kosten auf den Anteil,
  // der in Token getauscht werden musste (bei quote_only entfällt der Swap).
  const costs = global.paper.costs;
  const openCost =
    costs.priorityFeeSol + (opened.swappedSol * costs.swapSlippagePct) / 100;

  const atMs = at.getTime();
  return {
    binStep,
    minBinId: opened.minBinId,
    maxBinId: opened.maxBinId,
    bins: opened.bins,
    entryPrice: price,
    entryTokenShare: depositSol > 0 ? opened.swappedSol / depositSol : 0,
    lastPrice: price,
    depositSol,
    feesClaimedSol: 0,
    feesUnclaimedSol: 0,
    costsSol: openCost,
    txCount: opened.swappedSol > 0 ? 2 : 1,
    msInRange: 0,
    msTotal: 0,
    openedAtMs: atMs,
    lastTickMs: atMs,
    lastClaimMs: atMs,
    rebalanceCount: 0,
    lastRebalanceMs: null,
  };
}

/**
 * Verarbeitet eine Marktbeobachtung: Preisbewegung auf die Bins anwenden,
 * Fees akkumulieren, ggf. claimen und Exit-Bedingungen prüfen.
 */
export function tickPaperPosition(
  state: PaperPositionState,
  tick: MarketTick,
  preset: PresetConfig,
  global: GlobalConfig,
): PaperTickResult {
  const nowMs = tick.at.getTime();
  const elapsedMs = Math.max(0, nowMs - state.lastTickMs);

  const next: PaperPositionState = {
    ...state,
    bins: applyPriceMove(state.bins, tick.priceInSol),
    lastPrice: tick.priceInSol,
    lastTickMs: nowMs,
    msTotal: state.msTotal + elapsedMs,
  };

  const inRange = isInRange(next.bins, tick.priceInSol);
  if (inRange) next.msInRange += elapsedMs;

  // --- Fee-Akkrual -------------------------------------------------------
  // Nur wer im aktiven Bin liegt, verdient Fees. Der eigene Anteil am
  // Fee-Fluss wird über den Anteil am Pool-TVL geschätzt (die tatsächliche
  // Verteilung anderer LPs ist von außen nicht beobachtbar) und zusätzlich
  // per feeShareHaircutPct konservativ gekürzt.
  if (inRange && elapsedMs > 0 && tick.poolTvlUsd > 0 && tick.solPriceUsd > 0) {
    const totals = totalsOf(next.bins, tick.priceInSol);
    const poolTvlSol = tick.poolTvlUsd / tick.solPriceUsd;
    const share = poolTvlSol > 0 ? Math.min(1, totals.valueSol / poolTvlSol) : 0;
    const volumeSolInWindow =
      (tick.poolVolume24hUsd / tick.solPriceUsd) * (elapsedMs / 86_400_000);
    const grossFees = volumeSolInWindow * (tick.poolFeePct / 100) * share;
    next.feesUnclaimedSol += grossFees * (1 - global.paper.feeShareHaircutPct / 100);
  }

  // --- Fee-Claim ---------------------------------------------------------
  // Geclaimt wird nach Intervall UND nur, wenn der Betrag die Kosten lohnt
  // (KONZEPT.md Abschnitt 8.3).
  const harvest = preset.feeHarvest;
  const costs = global.paper.costs;
  const claimDue = nowMs - state.lastClaimMs >= harvest.claimIntervalMin * 60_000;
  const claimWorth =
    next.feesUnclaimedSol >=
    Math.max(harvest.minClaimValueSol, costs.priorityFeeSol * harvest.claimCostFactor);
  if (claimDue && claimWorth) {
    const claimed = next.feesUnclaimedSol;
    // Konvertierungskosten fallen auf den Anteil an, der in SOL getauscht wird.
    const converted = (claimed * harvest.convertToSolPct) / 100;
    next.costsSol += costs.priorityFeeSol + (converted * costs.swapSlippagePct) / 100;
    next.txCount += converted > 0 ? 2 : 1;
    next.feesClaimedSol += claimed;
    next.feesUnclaimedSol = 0;
    next.lastClaimMs = nowMs;
  }

  const valuation = valuePosition(next, tick.priceInSol);
  return { state: next, valuation, closeReason: evaluateExit(next, valuation, preset, nowMs) };
}

/** Bewertet die Position zum gegebenen Preis inkl. HODL-Vergleich. */
export function valuePosition(state: PaperPositionState, price: number): PaperValuation {
  const totals = totalsOf(state.bins, price);
  const totalValueSol =
    totals.valueSol + state.feesClaimedSol + state.feesUnclaimedSol - state.costsSol;
  const pnlSol = totalValueSol - state.depositSol;
  const hodlValueSol = hodlBenchmark(state, price);

  return {
    tokenAmount: totals.tokenAmount,
    solAmount: totals.solAmount,
    positionValueSol: totals.valueSol,
    totalValueSol,
    pnlSol,
    pnlPct: state.depositSol > 0 ? (pnlSol / state.depositSol) * 100 : 0,
    hodlValueSol,
    vsHodlSol: totalValueSol - hodlValueSol,
    timeInRangePct: state.msTotal > 0 ? (state.msInRange / state.msTotal) * 100 : 0,
    inRange: isInRange(state.bins, price),
  };
}

/**
 * Wert des Einsatzes bei reinem Halten. Referenz ist die Zusammensetzung beim
 * Eröffnen: quote_only startet zu 100 % in SOL (HODL = Einsatz unverändert),
 * balanced startet gemischt und nimmt daher an der Preisbewegung teil.
 */
function hodlBenchmark(state: PaperPositionState, price: number): number {
  if (state.entryPrice <= 0) return state.depositSol;
  const solPart = state.depositSol * (1 - state.entryTokenShare);
  const tokenPart = (state.depositSol * state.entryTokenShare) / state.entryPrice;
  return solPart + tokenPart * price;
}

function evaluateExit(
  state: PaperPositionState,
  valuation: PaperValuation,
  preset: PresetConfig,
  nowMs: number,
): PaperCloseReason | null {
  if (valuation.pnlPct <= -preset.stopLossPct) return "stop_loss";
  if (preset.takeProfitPct !== undefined && valuation.pnlPct >= preset.takeProfitPct) {
    return "take_profit";
  }
  if (nowMs - state.openedAtMs >= preset.maxHoldHours * 3_600_000) return "max_hold_time";

  // Ohne Rebalancing ist eine Position außerhalb der Range totes Kapital:
  // sie verdient keine Fees mehr und wird geschlossen statt gehalten.
  if (!preset.rebalance.enabled && !valuation.inRange && state.msTotal > 0) return "out_of_range";

  return null;
}

export interface PaperCloseResult {
  state: PaperPositionState;
  valuation: PaperValuation;
  /** Realisierter Erlös in SOL nach allen simulierten Kosten. */
  proceedsSol: number;
  realizedPnlSol: number;
}

/**
 * Schließt die Position: unclaimed Fees vereinnahmen, Token-Bestand in SOL
 * verkaufen (mit Slippage-Kosten), Transaktionskosten buchen.
 */
export function closePaperPosition(
  state: PaperPositionState,
  price: number,
  global: GlobalConfig,
): PaperCloseResult {
  const costs = global.paper.costs;
  const totals = totalsOf(state.bins, price);
  const tokenValueSol = totals.tokenAmount * price;

  // Close = remove liquidity + close position; Swap nur bei Token-Restbestand.
  const closeCost =
    costs.priorityFeeSol * (tokenValueSol > 0 ? 2 : 1) +
    (tokenValueSol * costs.swapSlippagePct) / 100;

  const next: PaperPositionState = {
    ...state,
    lastPrice: price,
    feesClaimedSol: state.feesClaimedSol + state.feesUnclaimedSol,
    feesUnclaimedSol: 0,
    costsSol: state.costsSol + closeCost,
    txCount: state.txCount + (tokenValueSol > 0 ? 2 : 1),
  };

  const valuation = valuePosition(next, price);
  return {
    state: next,
    valuation,
    proceedsSol: valuation.totalValueSol,
    realizedPnlSol: valuation.pnlSol,
  };
}
