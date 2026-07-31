import type { PresetKind } from "../config/schema";
import type { PoolObservation } from "./poolHealth";

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
  /**
   * Gebührenertragsrate des Pools beim Eröffnen (% des TVL je Tag).
   *
   * Bezugsgröße des `fee_collapse`-Exits: Ein Pool, der bei Einstieg 12 %/Tag
   * abwarf und jetzt 1 % abwirft, ist nicht mehr derselbe Pool — und das steht
   * im PnL erst, wenn es zu spät ist.
   */
  entryFeeRatePctPerDay: number;
  /**
   * Rollierende Pool-Beobachtungen für die zustandsabhängigen Ausstiegsregeln.
   *
   * Die Engine sah bisher je Tick nur die Gegenwart und konnte deshalb keine
   * Veränderung beurteilen. Das Fenster ist durch `exit` begrenzt und gedeckelt,
   * damit der als JSON persistierte Zustand nicht wächst.
   */
  poolHistory: PoolObservation[];
  /**
   * Aus der Volatilität hergeleitete Bin-Zahl **vor** den Leitplanken.
   * `null`, wenn ohne Herleitung eröffnet wurde (keine Volatilitätsschätzung
   * oder kein `coverageSigmas`) — dann galt die Mitte von `binRange`.
   */
  binWidthDerived?: number | null;
  /**
   * An welche Leitplanke die Herleitung gestoßen ist, oder `null`.
   *
   * Eine geklemmte Breite ist nicht die Breite, die der Markt verlangt. Ohne
   * diesen Ausweis passiert das lautlos — und zwar bevorzugt bei den volatilen
   * Pools, also genau dort, wo die Herleitung den größten Unterschied macht.
   */
  binWidthClamped?: "min" | "max" | null;
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
   * Dasselbe Volumen aus dem **trägsten** verfügbaren Zeitfenster.
   *
   * Für den Gebühren-Akkrual über ein 15-Minuten-Intervall ist das kürzeste
   * Fenster richtig — es löst Volatilitätsphasen auf. Für **Projektionen** über
   * Stunden oder Tage ist es falsch: Eine 30-Minuten-Volumenspitze zur
   * Dauerannahme zu erklären, überschätzt den erwarteten Ertrag um
   * Größenordnungen und öffnete damit das EV-Tor vor jedem Rebalance
   * (ANALYSE.md 4.1). Fehlt der Wert, fällt die Projektion auf
   * `poolVolume24hUsd` zurück.
   */
  poolVolume24hUsdSlow?: number;
  /**
   * Höchst- und Tiefstkurs **innerhalb** des Tick-Intervalls, in SOL.
   *
   * Eine laufende Stichprobe kennt sie nicht — sie sieht nur den Preis zum
   * Messzeitpunkt. Nachgeladene Kerzen liefern sie, und der Unterschied ist
   * keine Feinheit: Zwischen zwei Schlusskursen kann der Preis die Range
   * verlassen und zurückkehren, ohne je in einer Stichprobe aufzutauchen.
   * Solange die Engine nur Schlusskurse sah, wirkte das durchgehend in **eine**
   * Richtung — Zeit in Range überschätzt, Stop-Loss und Preissturz zu selten
   * ausgelöst.
   *
   * Fehlen sie, fällt jede Auswertung auf `priceInSol` zurück; das Verhalten ist
   * dann exakt das frühere.
   */
  priceHigh?: number;
  priceLow?: number;
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
  /**
   * In welcher Währung die Gebühren dieses Pools anfallen (`collect_fee_mode`
   * zusammen mit der Frage, auf welcher Seite SOL steht).
   *
   * Entscheidet über die **Konvertierungskosten beim Claim**: Fallen die
   * Gebühren ohnehin in SOL an (`quote`), gibt es nichts zu tauschen und keine
   * Slippage zu zahlen. Fallen sie im Memecoin an (`base`), muss alles durch
   * einen Swap. `mixed` ist der `InputOnly`-Fall, bei dem die Gebühr der
   * Handelsrichtung folgt.
   *
   * Fehlt die Angabe, wird der ungünstige Fall angenommen — die Gebühr also als
   * konvertierungspflichtig behandelt. Das entspricht dem früheren Verhalten.
   */
  feeCurrency?: "quote" | "base" | "mixed";
  /**
   * Ob der Pool Liquidity Mining betreibt.
   *
   * Seit `lb_clmm` 0.12.0 ist das zugleich die Auskunft darüber, ob er Limit
   * Orders unterstützt: Pools mit Rewards sind Liquidity-Mining-Pools, alle
   * übrigen wurden unumkehrbar zu Limit-Order-Pools. Nur bei letzteren zweigt
   * Order-Liquidität einen Teil der Gebühr ab.
   */
  liquidityMining?: boolean;
  solPriceUsd: number;
  at: Date;
}

/**
 * Warum eine Position geschlossen wurde.
 *
 * `take_profit` ist entfallen: Der Preisgewinn einer DLMM-Position ist durch
 * ihre Range gedeckelt (+1 bis +2 % bei den ausgelieferten Presets), die
 * Schwellen standen bei 30–50 %. Die Regel konnte nie auslösen und ließ ein
 * einseitiges Regelwerk zurück. An ihre Stelle treten die zustandsabhängigen
 * Gründe aus `poolHealth.ts`.
 */
export type PaperCloseReason =
  | "stop_loss"
  | "max_hold_time"
  | "out_of_range"
  | "price_crash"
  | "tvl_drain"
  | "fee_collapse"
  | "fee_stall"
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
  /**
   * Summe der Einsätze aller Positionen dieses Presets.
   *
   * Die Bezugsgröße, die dem Vergleich fehlte: Ein Preset mit dreifacher
   * Positionsgröße zeigt bei gleicher Güte dreifachen absoluten PnL. Ohne diesen
   * Nenner misst die Tabelle Kapitaleinsatz statt Strategie (ANALYSE.md 4.3).
   */
  depositedSol: number;
  feesEarnedSol: number;
  costsSol: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgTimeInRangePct: number | null;
  vsHodlSol: number;
}
