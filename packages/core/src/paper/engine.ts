import type { GlobalConfig, PresetConfig } from "../config/schema";
import {
  activeBinValueSol,
  applyPriceMove,
  binIdFromPrice,
  coverageHorizonHours,
  crossedBins,
  deriveBinWidth,
  inRangeShare,
  isInRange,
  recenterBins,
  totalsOf,
  type BinWidth,
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
 * Priority Fees je Transaktion, Slippage je Swap (**größenabhängig**: Grundsatz
 * plus Preisimpact je Anteil am Pool-TVL, gedeckelt durch `slippageCapPct`) und
 * die Composition Fee beim Einzahlen in den aktiven Bin. Positions-Rent ist
 * erstattungsfähig und damit gebundenes Kapital, kein Aufwand.
 * Infrastrukturkosten (VPS, RPC-Tarife) bleiben außen vor: Sie sind monatlicher
 * Fixaufwand, keiner Position zurechenbar, und würden den Preset-Vergleich
 * verzerren statt ihn zu schärfen.
 *
 * Gebührenmodell nach der DLMM-Doku (core-products/dlmm/formulas):
 * - Gebühren entstehen **je Bin**, und zwar in den Bins, die am Swap
 *   teilgenommen haben. Der Anteil daran ist die eigene Liquidität dort geteilt
 *   durch die gesamte Liquidität dort.
 * - Auf **Limit-Order-Pools** wird die Gebühr zuerst nach Liquiditätsquelle
 *   geteilt; was Order-Liquidität gefüllt hat, erreicht Market-Maker-LPs nicht.
 *   Seit `lb_clmm` 0.12.0 ist das der Regelfall für Pools ohne Rewards.
 * - Vom verbleibenden Aufkommen geht der `protocol_share` ab (10 % Standard-Pool,
 *   20 % Launch-Pool); nur der Rest ist LP-Gebühr.
 * - Maßgeblich ist die Gesamtgebühr (Basis + Volatilitätsaufschlag), nicht die
 *   Basisgebühr.
 * - `collect_fee_mode` entscheidet, in welcher Währung die Gebühr anfällt und
 *   damit, ob der Claim noch einen Konvertierungs-Swap kostet.
 */

/**
 * Bin-Breite einer Position dieses Presets, samt Herkunft.
 *
 * Der Horizont ist **die Zeit bis zur nächsten Korrekturmöglichkeit**, nicht die
 * Haltedauer (`coverageHorizonHours`). Eine Position, die rebalanciert, muss
 * ihre Range nur bis zum Ablauf des Cooldowns tragen — danach kann sie
 * nachzentrieren. Eine ohne Rebalancing muss die gesamte Haltedauer überstehen.
 *
 * Der Unterschied ist groß: Die Breite wächst mit √Horizont, und über 96 Stunden
 * statt 2 wäre sie siebenmal so weit. Eine solche Range hält den Preis zwar
 * zuverlässig, verteilt die Liquidität aber über so viele Bins, dass im aktiven
 * kaum noch etwas liegt — und nur der verdient. Genau diese Spannung ist das
 * LP-Dilemma; sie lässt sich nicht auflösen, nur bewusst einstellen.
 */
function binWidthFor(
  preset: PresetConfig,
  binStep: number,
  volatilityPctDaily: number | null | undefined,
): BinWidth {
  return deriveBinWidth({
    binRange: preset.binRange,
    binStep,
    horizonHours: coverageHorizonHours(preset),
    volatilityPctDaily,
    sided: preset.strategy.sided,
  });
}

/** Protokollanteil, wenn der Pool keinen meldet — Standard-Pool nach Doku. */
const DEFAULT_PROTOCOL_FEE_PCT = 10;

/**
 * Slippage-Kosten eines Swaps in SOL — **größenabhängig**.
 *
 * **Warum das nicht pauschal sein darf.** Bisher kostete jeder Swap denselben
 * Prozentsatz, ob 0,1 oder 5 SOL durch den Pool gingen. Falsch ist das genau
 * dort, wo es zählt: beim Ausstieg aus einer Position, die für ihren Pool zu
 * groß geworden ist — und damit im Verlust-Tail, den die Simulation abbilden
 * soll. Eine 5-SOL-Position in einem 120-k$-Pool bewegt beim Verkauf den Preis;
 * eine Pauschale von 0,5 % behauptet, sie täte es nicht.
 *
 * Modell: Grundslippage plus `swapImpactFactor` je Anteil am Pool-TVL, gedeckelt
 * durch `slippageCapPct` des Presets. Der Deckel ist nicht Kosmetik — er war
 * bislang **im Schema definiert, in der UI editierbar und von keiner Logik
 * gelesen**. Fachlich ist er die Grenze, ab der ein Ausstieg abgebrochen und
 * gestückelt würde; im Modell begrenzt er, wie weit die lineare Näherung
 * getrieben wird, denn linear ist der Impact nur für kleine Anteile.
 *
 * Ohne bekannten Pool-TVL bleibt es bei der Grundslippage: Eine Größe, die
 * niemand kennt, wird nicht geschätzt.
 */
function swapCostSol(params: {
  swapValueSol: number;
  poolTvlSol: number | null;
  preset: PresetConfig;
  global: GlobalConfig;
}): number {
  const { swapValueSol, poolTvlSol, preset, global } = params;
  if (swapValueSol <= 0) return 0;

  const basePct = global.paper.costs.swapSlippagePct;
  const impactPct =
    poolTvlSol !== null && poolTvlSol > 0
      ? global.paper.swapImpactFactor * (swapValueSol / poolTvlSol) * 100
      : 0;

  return (swapValueSol * Math.min(basePct + impactPct, preset.slippageCapPct)) / 100;
}

/** Pool-TVL in SOL, sofern beide Bezugsgrößen belegt sind. */
function poolTvlSolOf(tick: Pick<MarketTick, "poolTvlUsd" | "solPriceUsd">): number | null {
  if (tick.poolTvlUsd <= 0 || tick.solPriceUsd <= 0) return null;
  return tick.poolTvlUsd / tick.solPriceUsd;
}

/**
 * Anteil der geclaimten Gebühren, der überhaupt getauscht werden muss.
 *
 * `collect_fee_mode` entscheidet, in welcher Währung Gebühren anfallen, und das
 * war bislang nur ein Merkmal im Datensatz — die Kostenrechnung buchte
 * unterschiedslos einen Konvertierungs-Swap. Bei `only_y` mit SOL als Token Y
 * fallen die Gebühren aber bereits in SOL an: Es gibt nichts zu tauschen, und
 * damit auch keine Slippage zu zahlen. Das ist ein echter Vorteil solcher Pools,
 * und die Simulation hat ihn verschenkt.
 *
 * `mixed` ist der `InputOnly`-Fall: Die Gebühr folgt der Handelsrichtung, also
 * fällt sie über die Zeit etwa hälftig auf beiden Seiten an.
 *
 * Ohne Angabe gilt der ungünstige Fall — alles im Token, alles zu tauschen. Das
 * entspricht dem früheren Verhalten.
 */
function convertibleShare(feeCurrency: MarketTick["feeCurrency"]): number {
  switch (feeCurrency) {
    case "quote":
      return 0;
    case "mixed":
      return 0.5;
    default:
      return 1;
  }
}

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
  /**
   * Pool-TVL in SOL beim Eröffnen. Bezugsgröße des Preisimpacts des
   * Einstiegs-Swaps; ohne sie bleibt es bei der Grundslippage.
   */
  poolTvlSol?: number | null;
  at: Date;
}

export function openPaperPosition(params: OpenPaperPositionParams): PaperPositionState {
  const { preset, global, binStep, price, depositSol, at } = params;
  const width = binWidthFor(preset, binStep, params.volatilityPctDaily);

  const opened = recenterBins({
    price,
    binStep,
    binCount: width.bins,
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
    swapCostSol({
      swapValueSol: opened.swappedSol,
      poolTvlSol: params.poolTvlSol ?? null,
      preset,
      global,
    }) +
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
    binWidthDerived: width.derived,
    binWidthClamped: width.clamped,
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
  // Extrema des Intervalls, auf den Schlusskurs eingeklammert: Eine Kerze, deren
  // Hoch unter ihrem Schluss läge, wäre widersprüchlich und darf das Ergebnis
  // nicht verschieben.
  const priceLow = Math.min(tick.priceLow ?? tick.priceInSol, tick.priceInSol);
  const priceHigh = Math.max(tick.priceHigh ?? tick.priceInSol, tick.priceInSol);

  const next: PaperPositionState = {
    ...state,
    bins: applyPriceMove(state.bins, tick.priceInSol),
    lastPrice: tick.priceInSol,
    lastTickMs: nowMs,
    msTotal: state.msTotal + elapsedMs,
  };

  // Anteilig statt ja/nein: Wo die Kerze ihre Spanne mitbringt, wird die Zeit in
  // Range gemessen und nicht am Intervallende abgetastet.
  next.msInRange += elapsedMs * inRangeShare(next.bins, tick.priceInSol, priceLow, priceHigh);
  // Für "hat der Markt die Range erreicht?" zählt das Tief: Eine einseitige
  // Position wird von einer Docht-Bewegung genauso befüllt wie von einem
  // Schlusskurs — sie hat den Token dann tatsächlich gekauft.
  if (rangeIsReached(next, priceLow)) next.rangeReached = true;

  // --- Fee-Akkrual -------------------------------------------------------
  // Berührt hat der Preis alles zwischen dem letzten Stand und den Extrema
  // dieses Intervalls — das ist die Menge der Bins, die am Handel teilgenommen
  // und damit verdient haben.
  if (elapsedMs > 0) {
    next.feesUnclaimedSol += accrueFees(next, tick, global, elapsedMs, {
      fromPrice: Math.min(state.lastPrice, priceLow),
      toPrice: Math.max(state.lastPrice, priceHigh),
    });
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
    // Konvertierungskosten fallen nur auf den Anteil an, der überhaupt in einer
    // anderen Währung anfällt — bei einem `only_y`-Pool mit SOL als Token Y ist
    // das nichts.
    const converted =
      (claimed * convertibleShare(tick.feeCurrency) * harvest.convertToSolPct) / 100;
    next.costsSol +=
      costs.priorityFeeSol +
      swapCostSol({ swapValueSol: converted, poolTvlSol: poolTvlSolOf(tick), preset, global });
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
      ...(priceHigh > tick.priceInSol ? { priceHigh } : {}),
      ...(priceLow < tick.priceInSol ? { priceLow } : {}),
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
  const exitBeforeRebalance = decideExit(state, next, preset, nowMs, tick.priceInSol, priceLow);
  if (exitBeforeRebalance === null && shouldRebalance(next, tick, preset, global, nowMs)) {
    applyRebalance(next, tick, preset, global, nowMs);
  }

  return (
    decideExit(state, next, preset, nowMs, tick.priceInSol, priceLow) ?? {
      state: next,
      valuation: valuePosition(next, tick.priceInSol),
      closeReason: null,
    }
  );
}

/**
 * Ausstiegsentscheidung über das gesamte Intervall, nicht nur an seinem Ende.
 *
 * Zuerst am Schlusskurs — der Normalfall. Löst dort nichts aus, wird zusätzlich
 * am **Tief** des Intervalls geprüft. Der Grund ist kein Modelldetail: Ein
 * Stop-Loss ist eine Auslösung, kein Endstandsvergleich. Eine Position, die
 * zwischen zwei Messpunkten unter die Schwelle fällt und sich erholt, wurde in
 * Wahrheit ausgestoppt — solange die Engine nur Schlusskurse sah, löste ihr
 * einziger Notausgang systematisch zu selten aus.
 *
 * Löst der Ausstieg erst am Tief aus, wird die Position **dort** bewertet: Sie
 * ist dort ausgestiegen, nicht am freundlicheren Schlusskurs. Die Bins dafür
 * entstehen aus dem Bestand **vor** dem Tick — der Weg führte vom letzten Preis
 * zum Tief, nicht vom Schlusskurs rückwärts.
 *
 * `null` heißt: kein Ausstieg, weder am Schluss noch am Tief.
 */
function decideExit(
  before: PaperPositionState,
  next: PaperPositionState,
  preset: PresetConfig,
  nowMs: number,
  closePrice: number,
  priceLow: number,
): PaperTickResult | null {
  const valuation = valuePosition(next, closePrice);
  const atClose = evaluateExit(next, valuation, preset, nowMs);
  if (atClose !== null) return { state: next, valuation, closeReason: atClose };

  if (priceLow >= closePrice) return null;

  const atLow: PaperPositionState = {
    ...next,
    bins: applyPriceMove(before.bins, priceLow),
    lastPrice: priceLow,
  };
  const lowValuation = valuePosition(atLow, priceLow);
  const reason = evaluateExit(atLow, lowValuation, preset, nowMs);
  return reason === null ? null : { state: atLow, valuation: lowValuation, closeReason: reason };
}

/**
 * Gebühren des abgelaufenen Intervalls in SOL.
 *
 * Modell nach der DLMM-Doku: Gebühren entstehen **je Bin**, und zwar in den
 * Bins, die am Swap teilgenommen haben. Der Anteil daran ist `eigene Liquidität
 * in den berechtigten Bins / Gesamtliquidität dort`. Die fremde Verteilung ist
 * nicht beobachtbar — sie wird als gleichmäßig über `poolLiquidityBins` Bins
 * angenommen. Dadurch zahlt sich Konzentration nahe am Preis aus, was die
 * Strategietypen (Spot/Curve/BidAsk) überhaupt erst unterscheidbar macht: Über
 * den bloßen TVL-Anteil gerechnet wären sie identisch.
 *
 * `span` benennt den Preisbereich, den der Markt im Intervall berührt hat.
 * Fehlt er — etwa bei einer Projektion in die Zukunft, wo niemand weiß, wohin
 * der Preis läuft —, zählt allein der aktive Bin. Das ist die konservative
 * Lesart und entspricht dem früheren Verhalten.
 */
function accrueFees(
  state: PaperPositionState,
  tick: MarketTick,
  global: GlobalConfig,
  elapsedMs: number,
  span?: { fromPrice: number; toPrice: number },
): number {
  if (tick.poolTvlUsd <= 0 || tick.solPriceUsd <= 0 || tick.poolFeePct <= 0) return 0;

  const own = crossedBins(
    state.bins,
    span?.fromPrice ?? tick.priceInSol,
    span?.toPrice ?? tick.priceInSol,
    state.binStep,
  );
  if (own.valueSol <= 0) return 0; // Kein berührter Bin gehört zur Position.

  const poolTvlSol = tick.poolTvlUsd / tick.solPriceUsd;
  const ownTotalSol = totalsOf(state.bins, tick.priceInSol).valueSol;
  // Fremdliquidität in den berührten Bins unter der Gleichverteilungsannahme.
  // Mehr als ihren gesamten Bestand können andere dort nicht liegen haben —
  // bei einer Bewegung über mehr Bins, als die Annahme dem Pool zugesteht,
  // greift der Deckel.
  const othersTotalSol = Math.max(0, poolTvlSol - ownTotalSol);
  const othersShare = Math.min(1, own.binCount / global.paper.poolLiquidityBins);
  const othersCrossedSol = othersTotalSol * othersShare;

  const denominator = own.valueSol + othersCrossedSol;
  if (denominator <= 0) return 0;
  const share = own.valueSol / denominator;

  const volumeSolInWindow =
    (tick.poolVolume24hUsd / tick.solPriceUsd) * (elapsedMs / 86_400_000);
  const tradingFees = volumeSolInWindow * (tick.poolFeePct / 100);

  // Vor allem anderen: Auf einem Limit-Order-Pool wird die Handelsgebühr
  // zuerst nach **Liquiditätsquelle** aufgeteilt. Was Limit-Order-Liquidität
  // gefüllt hat, geht zur Hälfte an die Order-Steller und zur anderen Hälfte
  // ans Protokoll — an Market-Maker-LPs davon nichts.
  const mmShare = 1 - limitOrderShare(tick, global) / 100;

  // Vom MM-Anteil geht der Protokollanteil ab, bevor LPs verteilt wird.
  const protocolPct = tick.protocolFeePct ?? DEFAULT_PROTOCOL_FEE_PCT;
  const lpFees = tradingFees * mmShare * (1 - clamp(protocolPct, 0, 100) / 100);

  return lpFees * share * (1 - global.paper.feeShareHaircutPct / 100);
}

/**
 * Angenommener Anteil der Handelsgebühr, den Limit-Order-Liquidität abzweigt.
 *
 * **Warum das eine eigene Größe ist und nicht im Sammel-Abschlag verschwindet.**
 * Mit `lb_clmm` 0.12.0 (Mainnet Mai 2026) wurde jeder bestehende Pool **ohne
 * Liquidity-Mining-Rewards** unumkehrbar zum Limit-Order-Pool — also praktisch
 * jeder Memecoin-Pool, den die Presets suchen. Dort teilt das Programm die
 * Gebühr zuerst nach Liquiditätsquelle auf; der Limit-Order-Teil geht je zur
 * Hälfte an die Order-Steller und ans Protokoll. Für Market-Maker-LPs bleibt
 * davon nichts.
 *
 * Das ist eine Ertragsminderung, die es vorher nicht gab, und sie in
 * `feeShareHaircutPct` zu verstecken hieße, zwei Annahmen mit verschiedenen
 * Ursachen und verschiedenen Messwegen als eine zu führen. Getrennt geführt
 * lässt sie sich im Stresstest einzeln bewegen und später durch eine Messung
 * aus den `/positions/.../historical`-Events ersetzen.
 *
 * Der Pooltyp wird abgeleitet, nicht geraten: Reward-Mints oder eine Farm heißt
 * Liquidity-Mining-Pool, und dort gibt es keine Limit Orders.
 */
function limitOrderShare(tick: MarketTick, global: GlobalConfig): number {
  return tick.liquidityMining === true ? 0 : global.paper.limitOrderShareHaircutPct;
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
    state.bins.length > 0 ? state.bins.length : binWidthFor(preset, state.binStep, null).bins;
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
    swapCostSol({
      swapValueSol: target.swappedSol,
      poolTvlSol: poolTvlSolOf(tick),
      preset,
      global,
    }) +
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
 * Kontext des Ausstiegs, soweit er die Kosten bestimmt.
 *
 * Optional, weil `closePaperPosition` auch ohne frische Marktdaten aufgerufen
 * werden können muss. Fehlt der Kontext, gilt die Grundslippage — dieselbe
 * Rechnung wie vor der Größenabhängigkeit.
 */
export interface ClosePaperPositionContext {
  preset: PresetConfig;
  /** Pool-TVL in SOL zum Ausstiegszeitpunkt. */
  poolTvlSol?: number | null;
}

/**
 * Schließt die Position: unclaimed Fees vereinnahmen, Token-Bestand in SOL
 * verkaufen (mit Slippage-Kosten), Transaktionskosten buchen.
 *
 * Der Verkauf des Restbestands ist der größte Einzel-Swap im Leben einer
 * Position und damit die Stelle, an der die Größenabhängigkeit der Slippage am
 * meisten ausmacht: Er trifft den Verlust-Tail, und der Verlust-Tail ist das,
 * wofür die Simulation gebaut ist.
 */
export function closePaperPosition(
  state: PaperPositionState,
  price: number,
  global: GlobalConfig,
  context?: ClosePaperPositionContext,
): PaperCloseResult {
  const costs = global.paper.costs;
  const totals = totalsOf(state.bins, price);
  const tokenValueSol = totals.tokenAmount * price;

  // Close = remove liquidity + close position; Swap nur bei Token-Restbestand.
  const closeCost =
    costs.priorityFeeSol * (tokenValueSol > 0 ? 2 : 1) +
    (context === undefined
      ? (tokenValueSol * costs.swapSlippagePct) / 100
      : swapCostSol({
          swapValueSol: tokenValueSol,
          poolTvlSol: context.poolTvlSol ?? null,
          preset: context.preset,
          global,
        }));

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
