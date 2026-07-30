import type { PresetKind } from "../config/schema";

/** Ein Liquiditäts-Bin der simulierten Position. */
export interface SimBin {
  /** Bin-ID relativ zur DLMM-Bin-Skala. */
  id: number;
  /** Untergrenze/Referenzpreis des Bins in SOL je Token. */
  price: number;
  /** Gehaltene SOL (Bins unterhalb des aktiven Preises). */
  sol: number;
  /** Gehaltene Token (Bins oberhalb des aktiven Preises). */
  token: number;
}

/** Vollständiger Simulationszustand einer Paper-Position (JSON-serialisierbar). */
export interface PaperPositionState {
  binStep: number;
  minBinId: number;
  maxBinId: number;
  bins: SimBin[];
  /** Token-Preis in SOL beim Eröffnen. */
  entryPrice: number;
  /** Anteil des Einsatzes, der beim Eröffnen in Token gehalten wurde (0..1). */
  entryTokenShare: number;
  /** Zuletzt verarbeiteter Preis. */
  lastPrice: number;
  /** Eingesetztes Kapital in SOL (vor Kosten). */
  depositSol: number;
  /** Bereits geclaimte und in SOL bewertete Fees. */
  feesClaimedSol: number;
  /** Aufgelaufene, noch nicht geclaimte Fees in SOL. */
  feesUnclaimedSol: number;
  /** Summe aller simulierten On-Chain-Kosten in SOL (ohne Infrastruktur). */
  costsSol: number;
  /** Anzahl simulierter Transaktionen (Open/Claim/Rebalance/Close/Swap). */
  txCount: number;
  /** Millisekunden mit aktivem Preis innerhalb der Range. */
  msInRange: number;
  /** Gesamte beobachtete Laufzeit in Millisekunden. */
  msTotal: number;
  openedAtMs: number;
  lastTickMs: number;
  lastClaimMs: number;
  rebalanceCount: number;
  lastRebalanceMs: number | null;
  /**
   * Hat der Markt die Range jemals erreicht?
   *
   * Entscheidend für einseitige Positionen: Eine `quote_only`-Position liegt
   * per Konstruktion **unterhalb** des aktiven Bins und wartet dort auf
   * Befüllung — Meteora beschreibt das ausdrücklich als DCA-Muster ("Deposit
   * quote token single-sided … below the current price", Bid-Ask "may sit away
   * from the active price until the market moves into the edge bins"). Erst
   * nachdem der Markt sie erreicht hatte, ist "außerhalb der Range" ein
   * Exit-Grund und nicht der Normalzustand.
   *
   * Geprüft wird `Preis <= oberster Bin-Preis`, nicht `inRange`: Ein Preissturz
   * kann die Range zwischen zwei Messpunkten vollständig durchlaufen. Die
   * Position ist dann befüllt **und** wieder außerhalb — mit `inRange` allein
   * bliebe sie fälschlich als "nie erreicht" markiert.
   */
  rangeReached: boolean;
  /** Zeitstempel der Rebalances des laufenden Tages (für maxPerDay). */
  rebalanceTimesMs: number[];
}

/** Marktbeobachtung für einen Tick. */
export interface MarketTick {
  /** Token-Preis in SOL. */
  priceInSol: number;
  poolTvlUsd: number;
  /**
   * Handelsvolumen als **24-Stunden-Rate** in USD. Darf aus einem kürzeren
   * Fenster hochgerechnet sein (`volume.h1 × 24`) — das löst Volatilitätsphasen
   * schärfer auf als der träge 24-Stunden-Wert.
   */
  poolVolume24hUsd: number;
  /**
   * Gesamte Swap-Gebühr des Pools in Prozent (Basis + Volatilitätsaufschlag).
   * Nicht die Basisgebühr: Bei volatilen Pools ist sie ein Mehrfaches davon,
   * und genau dann verdient die Position.
   */
  poolFeePct: number;
  /**
   * Protokollanteil in % **der Gebühr** (Standard-Pool 10 %, Launch-Pool 20 %).
   * Der LP erhält nur den Rest. Fehlt die Angabe, wird der Standardwert
   * angenommen — 0 wäre die einzige Annahme, die sicher falsch ist.
   */
  protocolFeePct?: number;
  solPriceUsd: number;
  at: Date;
}

export type PaperCloseReason =
  | "stop_loss"
  | "take_profit"
  | "max_hold_time"
  | "out_of_range"
  | "manual";

export interface PaperValuation {
  /** Aktueller Token-Bestand der Position. */
  tokenAmount: number;
  /** Aktueller SOL-Bestand der Position. */
  solAmount: number;
  /** Marktwert der Position in SOL (ohne unclaimed Fees). */
  positionValueSol: number;
  /** Gesamtwert inkl. geclaimter und unclaimed Fees, abzüglich Kosten. */
  totalValueSol: number;
  /** Gesamt-PnL gegenüber dem Einsatz in SOL. */
  pnlSol: number;
  pnlPct: number;
  /** Wert, den reines Halten des Einsatzes ergeben hätte (HODL-Benchmark). */
  hodlValueSol: number;
  /** Differenz zu HODL — misst, ob LPing sich gegenüber Halten gelohnt hat. */
  vsHodlSol: number;
  /** Anteil der Laufzeit mit Preis in der Range. */
  timeInRangePct: number;
  inRange: boolean;
}

export interface PaperTickResult {
  state: PaperPositionState;
  valuation: PaperValuation;
  /** Gesetzt, wenn eine Exit-Bedingung ausgelöst hat. */
  closeReason: PaperCloseReason | null;
}

/** Zusammenfassung eines Presets für den Vergleich. */
export interface PresetPerformance {
  preset: PresetKind;
  label: string;
  openPositions: number;
  closedPositions: number;
  realizedPnlSol: number;
  unrealizedPnlSol: number;
  totalPnlSol: number;
  feesEarnedSol: number;
  costsSol: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgTimeInRangePct: number | null;
  vsHodlSol: number;
}
