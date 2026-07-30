import type { GlobalConfig, PresetConfig } from "../config/schema";
import {
  activeBinValueSol,
  applyPriceMove,
  binIdFromPrice,
  deriveBinCount,
  isInRange,
  recenterBins,
  totalsOf,
} from "./bins";
import { evaluatePoolExit, poolFeeRatePctPerDay, recordObservation } from "./poolHealth";
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
 * Priority Fees je Transaktion, Slippage/Preis-Impact je Swap und die
 * Composition Fee beim Einzahlen in den aktiven Bin. Positions-Rent ist
 * erstattungsfähig und damit gebundenes Kapital, kein Aufwand.
 * Infrastrukturkosten (VPS, RPC-Tarife) bleiben außen vor: Sie sind monatlicher
 * Fixaufwand, keiner Position zurechenbar, und würden den Preset-Vergleich
 * verzerren statt ihn zu schärfen.
 *
 * Gebührenmodell nach der DLMM-Doku (core-products/dlmm/formulas):
 * - Nur der **aktive Bin** verdient; der Anteil ist die eigene Liquidität dort
 *   geteilt durch die gesamte Liquidität dort.
 * - Vom Gebührenaufkommen geht der `protocol_share` ab (10 % Standard-Pool,
 *   20 % Launch-Pool); nur der Rest ist LP-Gebühr.
 * - Maßgeblich ist die Gesamtgebühr (Basis + Volatilitätsaufschlag), nicht die
 *   Basisgebühr.
 */

/**
 * Bin-Zahl einer Position dieses Presets.
 *
 * Der Horizont ist **die Zeit bis zur nächsten Korrekturmöglichkeit**, nicht die
 * Haltedauer. Eine Position, die rebalanciert, muss ihre Range nur bis zum
 * Ablauf des Cooldowns tragen — danach kann sie nachzentrieren. Eine ohne
 * Rebalancing muss die gesamte Haltedauer überstehen.
 *
 * Der Unterschied ist groß: Die Breite wächst mit √Horizont, und über 96 Stunden
 * statt 2 wäre sie siebenmal so weit. Eine solche Range hält den Preis zwar
 * zuverlässig, verteilt die Liquidität aber über so viele Bins, dass im aktiven
 * kaum noch etwas liegt — und nur der verdient. Genau diese Spannung ist das
 * LP-Dilemma; sie lässt sich nicht auflösen, nur bewusst einstellen.
 */
function binCountFor(
  preset: PresetConfig,
  binStep: number,
  volatilityPctDaily: number | null | undefined,
): number {
  const horizonHours = preset.rebalance.enabled
    ? Math.max(preset.rebalance.cooldownMin / 60, 1)
    : preset.maxHoldHours;

  return deriveBinCount({
    binRange: preset.binRange,
    binStep,
    horizonHours: Math.min(horizonHours, 24),
    volatilityPctDaily,
  });
}

/** Protokollanteil, wenn der Pool keinen meldet — Standard-Pool nach Doku. */
const DEFAULT_PROTOCOL_FEE_PCT = 10;

export interface OpenPaperPositionParams {
  preset: PresetConfig;
  global: GlobalConfig;
  binStep: number;
  /** Token-Preis in SOL zum Eröffnungszeitpunkt. */
  price: number;
  /** Einsatz in SOL (vor Kosten). */
  depositSol: number;
  /** Gesamtgebühr des Pools in % — Basis der Composition Fee beim Einstieg. */
  feePct: number;
  /**
   * Gebührenertragsrate des Pools beim Eröffnen (% des TVL je Tag). Bezugsgröße
   * des `fee_collapse`-Exits; ohne sie ist dieser Exit inaktiv.
   */
  feeRatePctPerDay?: number;
  /**
   * Realisierte Tagesvolatilität des Tokens in %. Steuert die Range-Breite,
   * wenn das Preset `binRange.coverageSigmas` setzt.
   */
  volatilityPctDaily?: number | null;
  at: Date;
}

export function openPaperPosition(params: OpenPaperPositionParams): PaperPositionState {
  const { preset, global, binStep, price, depositSol, at } = params;
  const binCount = binCountFor(preset, binStep, params.volatilityPctDaily);

  const opened = recenterBins({
    price,
    binStep,
    binCount,
    strategy: preset.strategy.type,
    sided: preset.strategy.sided,
    depositSol,
  });

  // Kosten des Einstiegs: eine Transaktion, Swap-Kosten auf den Anteil, der in
  // Token getauscht werden musste (bei quote_only entfällt der Swap), plus die
  // Composition Fee auf den Anteil, der in den aktiven Bin geht.
  const costs = global.paper.costs;
  const openCost =
    costs.priorityFeeSol +
    (opened.swappedSol * costs.swapSlippagePct) / 100 +
    compositionFee(opened.activeBinDepositSol, params.feePct);

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
    // Eine einseitige Position startet per Konstruktion außerhalb der Range.
    rangeReached: isInRange(opened.bins, price),
    rebalanceTimesMs: [],
    entryFeeRatePctPerDay: params.feeRatePctPerDay ?? 0,
    poolHistory: [],
  };
}

/**
 * Composition Fee: fällt an, wenn eine Einzahlung die Zusammensetzung des
 * **aktiven** Bins verändert — laut Doku "in a way that resembles a swap".
 * Auf leere oder nicht-aktive Bins wird sie nicht erhoben, deshalb ist die
 * Basis ausschließlich der Betrag, der in den aktiven Bin geht.
 */
function compositionFee(activeBinDepositSol: number, feePct: number): number {
  if (activeBinDepositSol <= 0 || feePct <= 0) return 0;
  const rate = feePct / 100;
  return activeBinDepositSol * rate * (1 + rate);
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
  if (rangeIsReached(next, tick.priceInSol)) next.rangeReached = true;

  // --- Fee-Akkrual -------------------------------------------------------
  if (elapsedMs > 0) {
    next.feesUnclaimedSol += accrueFees(next, tick, global, elapsedMs);
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

  // --- Pool-Beobachtung festhalten ---------------------------------------
  // Muss vor der Exit-Prüfung passieren: Die zustandsabhängigen Regeln
  // beurteilen eine Veränderung, und dafür gehört die Gegenwart zur Historie.
  next.poolHistory = recordObservation(
    next.poolHistory,
    {
      atMs: nowMs,
      priceInSol: tick.priceInSol,
      tvlUsd: tick.poolTvlUsd,
      feeRatePctPerDay: poolFeeRatePctPerDay(
        tick.poolVolume24hUsd,
        tick.poolFeePct,
        tick.poolTvlUsd,
      ),
      feesTotalSol: next.feesClaimedSol + next.feesUnclaimedSol,
    },
    preset.exit,
  );

  // --- Rebalancing -------------------------------------------------------
  // Der geordnete Exit hat Vorrang: nie in einen fallenden Preis nachzentrieren,
  // wenn die Position ohnehin geschlossen gehört (KONZEPT.md 8.2).
  const exitBeforeRebalance = evaluateExit(
    next,
    valuePosition(next, tick.priceInSol),
    preset,
    nowMs,
  );
  if (exitBeforeRebalance === null && shouldRebalance(next, tick, preset, global, nowMs)) {
    applyRebalance(next, tick, preset, global, nowMs);
  }

  const valuation = valuePosition(next, tick.priceInSol);
  return { state: next, valuation, closeReason: evaluateExit(next, valuation, preset, nowMs) };
}

/**
 * Gebühren des abgelaufenen Intervalls in SOL.
 *
 * Modell nach der DLMM-Doku: Gebühren entstehen im aktiven Bin, und der Anteil
 * daran ist `eigene Liquidität dort / gesamte Liquidität dort`. Die fremde
 * Verteilung ist nicht beobachtbar — sie wird als gleichmäßig über
 * `poolLiquidityBins` Bins angenommen. Dadurch zahlt sich Konzentration nahe am
 * Preis aus, was die Strategietypen (Spot/Curve/BidAsk) überhaupt erst
 * unterscheidbar macht: Über den bloßen TVL-Anteil gerechnet wären sie identisch.
 */
function accrueFees(
  state: PaperPositionState,
  tick: MarketTick,
  global: GlobalConfig,
  elapsedMs: number,
): number {
  if (tick.poolTvlUsd <= 0 || tick.solPriceUsd <= 0 || tick.poolFeePct <= 0) return 0;

  const ownActiveSol = activeBinValueSol(state.bins, tick.priceInSol, state.binStep);
  if (ownActiveSol <= 0) return 0; // Aktiver Bin außerhalb der Position.

  const poolTvlSol = tick.poolTvlUsd / tick.solPriceUsd;
  const ownTotalSol = totalsOf(state.bins, tick.priceInSol).valueSol;
  // Fremdliquidität im aktiven Bin unter der Gleichverteilungsannahme.
  const othersTotalSol = Math.max(0, poolTvlSol - ownTotalSol);
  const othersActiveSol = othersTotalSol / global.paper.poolLiquidityBins;

  const denominator = ownActiveSol + othersActiveSol;
  if (denominator <= 0) return 0;
  const share = ownActiveSol / denominator;

  const volumeSolInWindow =
    (tick.poolVolume24hUsd / tick.solPriceUsd) * (elapsedMs / 86_400_000);
  const tradingFees = volumeSolInWindow * (tick.poolFeePct / 100);

  // Der Protokollanteil geht vom Gebührenaufkommen ab, bevor LPs verteilt wird.
  const protocolPct = tick.protocolFeePct ?? DEFAULT_PROTOCOL_FEE_PCT;
  const lpFees = tradingFees * (1 - clamp(protocolPct, 0, 100) / 100);

  return lpFees * share * (1 - global.paper.feeShareHaircutPct / 100);
}

/**
 * Rebalance-Trigger (KONZEPT.md 8.2): Der aktive Bin hat die inneren
 * `100 − 2·bufferPct` Prozent der Range verlassen. Hysterese über Cooldown und
 * Tageslimit verhindert Zappeln in Seitwärtsphasen.
 */
function shouldRebalance(
  state: PaperPositionState,
  tick: MarketTick,
  preset: PresetConfig,
  global: GlobalConfig,
  nowMs: number,
): boolean {
  const rebalance = preset.rebalance;
  if (!rebalance.enabled) return false;

  const width = state.maxBinId - state.minBinId;
  if (width <= 0) return false;

  const activeId = binIdFromPrice(tick.priceInSol, state.binStep);
  const buffer = (width * rebalance.bufferPct) / 100;
  const insideBuffer =
    activeId >= state.minBinId + buffer && activeId <= state.maxBinId - buffer;
  if (insideBuffer) return false;

  if (
    state.lastRebalanceMs !== null &&
    nowMs - state.lastRebalanceMs < rebalance.cooldownMin * 60_000
  ) {
    return false;
  }

  const dayAgo = nowMs - 86_400_000;
  const recent = state.rebalanceTimesMs.filter((ts) => ts > dayAgo).length;
  if (recent >= rebalance.maxPerDay) return false;

  return rebalanceIsWorthIt(state, tick, preset, global, nowMs);
}

/**
 * Beobachtungsdauer, ab der die gemessene Zeit-in-Range die Projektion allein
 * trägt. Darunter wird sie gegen eine neutrale Vorannahme geschrumpft.
 */
const IN_RANGE_CONFIDENCE_MS = 6 * 3_600_000;

/** Neutrale Vorannahme über die Zeit in Range, solange nichts beobachtet ist. */
const IN_RANGE_PRIOR = 0.5;

/**
 * Erwartete Zeit in Range der **nachzentrierten** Position.
 *
 * Der bisherige Verlauf ist die beste verfügbare Schätzung — aber roh ist er
 * unbrauchbar: Ein Rebalance wird ausgelöst, *weil* die Position gerade
 * außerhalb liegt, und ganz früh im Leben einer Position ist die gemessene
 * Quote dann exakt 0. Die Projektion wäre null, und es käme nie ein Rebalance
 * zustande — der entgegengesetzte Fehler zum ursprünglichen.
 *
 * Deshalb Schrumpfung gegen eine neutrale Vorannahme, gewichtet mit der
 * Beobachtungsdauer: Am Anfang zählt die Vorannahme, nach einigen Stunden die
 * Messung.
 */
function expectedInRangeShare(state: PaperPositionState): number {
  if (state.msTotal <= 0) return IN_RANGE_PRIOR;
  const observed = clamp(state.msInRange / state.msTotal, 0, 1);
  const weight = clamp(state.msTotal / IN_RANGE_CONFIDENCE_MS, 0, 1);
  return weight * observed + (1 - weight) * IN_RANGE_PRIOR;
}

/**
 * EV-Prüfung vor dem Rebalance (KONZEPT.md 8.2): Der erwartete Zusatzertrag
 * muss die Kosten um `minEvFactor` übersteigen.
 *
 * **Diese Prüfung war wirkungslos** (ANALYSE.md 4.1). Sie projizierte die
 * momentane Gebührenrate über die *gesamte* Restlaufzeit — bei Konservativ bis
 * zu 336 Stunden — und unterstellte dabei, die Position liege diese ganze Zeit
 * im aktiven Bin, also 100 % Zeit in Range. Gemessen waren 50 bis 66 %. Kommt
 * das Volumen dann noch aus dem kürzesten Zeitfenster (`m30 × 48`), wird eine
 * halbstündige Volumenspitze zur Dauerannahme über vier Tage. Der geschätzte
 * Ertrag übertraf die Kosten um Größenordnungen, `minEvFactor` war immer
 * erfüllt, und die Rebalance-Häufigkeit folgte allein Cooldown und Tageslimit.
 *
 * Drei Korrekturen, jede gegen einen der Fehler:
 *
 * 1. **Begrenztes Fenster** statt Restlaufzeit.
 * 2. **Gewichtung mit der beobachteten Zeit in Range** statt der Annahme, sie
 *    sei vollständig.
 * 3. **Trägstes Volumenfenster** für die Projektion statt des kürzesten.
 */
function rebalanceIsWorthIt(
  state: PaperPositionState,
  tick: MarketTick,
  preset: PresetConfig,
  global: GlobalConfig,
  nowMs: number,
): boolean {
  const remainingMs = preset.maxHoldHours * 3_600_000 - (nowMs - state.openedAtMs);
  if (remainingMs <= 0) return false;

  const cost = estimateRebalanceCost(state, tick, preset, global);
  if (cost <= 0) return true;

  // Begrenztes Projektionsfenster statt der gesamten Restlaufzeit.
  const horizonMs = Math.min(remainingMs, preset.rebalance.projectionHours * 3_600_000);
  const inRangeShare = expectedInRangeShare(state);

  const projected = { ...state, ...recenteredBins(state, tick, preset) };
  const slowTick: MarketTick = {
    ...tick,
    poolVolume24hUsd: tick.poolVolume24hUsdSlow ?? tick.poolVolume24hUsd,
  };
  const expected = accrueFees(projected, slowTick, global, horizonMs) * inRangeShare;

  return expected >= cost * preset.rebalance.minEvFactor;
}

/**
 * Hat der Markt die Range erreicht? Wahr, sobald der Preis den obersten Bin
 * berührt oder unterschritten hat — auch wenn er die Range in einem Schritt
 * ganz durchlaufen hat und jetzt darunter liegt.
 */
function rangeIsReached(state: PaperPositionState, price: number): boolean {
  const top = state.bins[state.bins.length - 1];
  return top !== undefined && price <= top.price;
}

/** Bins, wie sie nach einem Rebalance um den aktuellen Preis lägen. */
function recenteredBins(
  state: PaperPositionState,
  tick: MarketTick,
  preset: PresetConfig,
): Pick<PaperPositionState, "bins" | "minBinId" | "maxBinId"> & {
  swappedSol: number;
  activeBinDepositSol: number;
} {
  const totals = totalsOf(state.bins, tick.priceInSol);
  // Dieselbe Breite wie beim Eröffnen: Ein Rebalance zentriert nach, er legt die
  // Position nicht neu aus.
  const binCount =
    state.bins.length > 0 ? state.bins.length : binCountFor(preset, state.binStep, null);
  const target = recenterBins({
    price: tick.priceInSol,
    binStep: state.binStep,
    binCount,
    strategy: preset.strategy.type,
    sided: preset.strategy.sided,
    depositSol: totals.valueSol,
  });

  // Was tatsächlich die Seite wechseln muss: Differenz zwischen dem
  // Token-Bestand von jetzt und dem Zielbestand.
  const currentTokenSol = totals.tokenAmount * tick.priceInSol;
  const swappedSol = Math.abs(target.swappedSol - currentTokenSol);

  return {
    bins: target.bins,
    minBinId: target.minBinId,
    maxBinId: target.maxBinId,
    swappedSol,
    activeBinDepositSol: target.activeBinDepositSol,
  };
}

/**
 * Kosten eines Rebalances.
 *
 * Nach der DLMM-Doku ist Rebalancing **ein** Ablauf (`rebalance_liquidity`:
 * claim, remove, resize, add) — die Position wird nicht geschlossen und neu
 * eröffnet. Deshalb zwei Transaktionen statt eines vollen Close/Open-Zyklus,
 * plus Swap-Kosten auf den umgeschichteten Betrag und die Composition Fee auf
 * den Anteil, der in den aktiven Bin geht.
 */
function estimateRebalanceCost(
  state: PaperPositionState,
  tick: MarketTick,
  preset: PresetConfig,
  global: GlobalConfig,
): number {
  const costs = global.paper.costs;
  const target = recenteredBins(state, tick, preset);
  return (
    costs.priorityFeeSol * 2 +
    (target.swappedSol * costs.swapSlippagePct) / 100 +
    compositionFee(target.activeBinDepositSol, tick.poolFeePct)
  );
}

/** Führt den Rebalance aus: Fees vereinnahmen, Range nachzentrieren, Kosten buchen. */
function applyRebalance(
  state: PaperPositionState,
  tick: MarketTick,
  preset: PresetConfig,
  global: GlobalConfig,
  nowMs: number,
): void {
  // Pflicht-Claim vor jedem Rebalance (KONZEPT.md 8.3).
  state.feesClaimedSol += state.feesUnclaimedSol;
  state.feesUnclaimedSol = 0;

  const cost = estimateRebalanceCost(state, tick, preset, global);
  const target = recenteredBins(state, tick, preset);

  state.bins = target.bins;
  state.minBinId = target.minBinId;
  state.maxBinId = target.maxBinId;
  state.costsSol += cost;
  state.txCount += 2;
  state.rebalanceCount += 1;
  state.lastRebalanceMs = nowMs;
  state.rebalanceTimesMs = [...state.rebalanceTimesMs.filter((ts) => ts > nowMs - 86_400_000), nowMs];
  // Nach dem Nachzentrieren liegt der Preis wieder in der Range.
  state.rangeReached = state.rangeReached || isInRange(target.bins, tick.priceInSol);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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

/**
 * Reihenfolge der Ausstiegsprüfung — sie ist die Rangfolge:
 *
 * 1. **Zustandsabhängige Regeln** (`poolHealth.ts`): Preissturz, Liquiditätsabzug,
 *    versiegender Ertrag. Sie drehen vor dem PnL und sind deshalb der primäre
 *    Ausgang.
 * 2. **Stop-Loss** als Rückfalllinie. Er macht als einziger keine Annahme über
 *    den Mechanismus und fängt den Fall ab, in dem alle Pool-Größen gesund
 *    aussehen und die Position dennoch ausblutet.
 * 3. Zeitlimit und tote Range.
 *
 * Einen Take-Profit gibt es nicht mehr; die Begründung steht in `poolHealth.ts`.
 */
function evaluateExit(
  state: PaperPositionState,
  valuation: PaperValuation,
  preset: PresetConfig,
  nowMs: number,
): PaperCloseReason | null {
  const poolExit = evaluatePoolExit({
    history: state.poolHistory,
    exit: preset.exit,
    entryFeeRatePctPerDay: state.entryFeeRatePctPerDay,
    depositSol: state.depositSol,
    ageMs: nowMs - state.openedAtMs,
    rangeReached: state.rangeReached,
  });
  if (poolExit !== null) return poolExit;

  if (valuation.pnlPct <= -preset.stopLossPct) return "stop_loss";
  if (nowMs - state.openedAtMs >= preset.maxHoldHours * 3_600_000) return "max_hold_time";

  // Ohne Rebalancing ist eine Position außerhalb der Range totes Kapital: sie
  // verdient keine Fees mehr und wird geschlossen statt gehalten.
  //
  // Ausnahme, und zwar die entscheidende: Eine einseitige Position liegt
  // **beim Eröffnen** außerhalb der Range und wartet dort auf Befüllung — das
  // ist das von Meteora dokumentierte DCA-Muster, nicht ein Fehlzustand. Erst
  // wenn der Preis die Range einmal erreicht hatte und sie wieder verlassen
  // hat, ist die Position tot. Ohne diese Unterscheidung wird jede
  // quote_only-Position im ersten Tick geschlossen, verdient nie eine Gebühr,
  // und der Preset-Vergleich misst nur noch die Eröffnungskosten.
  //
  // Wer nie befüllt wird, läuft ins Zeitlimit oben — das ist der richtige Exit
  // für eine Kauforder, die der Markt nicht erreicht hat.
  if (
    !preset.rebalance.enabled &&
    !valuation.inRange &&
    state.rangeReached &&
    state.msTotal > 0
  ) {
    return "out_of_range";
  }

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
