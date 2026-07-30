import type { GlobalConfig, PresetConfig, PresetKind } from "../config/schema";
import type {
  CandidateSource,
  PoolMetrics,
  SellabilityCheck,
  TokenRiskReport,
} from "../domain/types";

/**
 * Aggregierter Markt-Querschnitt eines Tokens über alle DexScreener-Paare
 * (KONZEPT.md Abschnitt 5.3). `null` = Information nicht verfügbar.
 */
export interface MarketAggregates {
  /** Alter des ältesten bekannten Handelspaars in Stunden. */
  tokenAgeHours: number | null;
  /** Summe der Liquidität über alle Paare (USD). */
  totalLiquidityUsd: number | null;
  /** Summe 24h-Volumen über alle Paare (USD). */
  volume24hUsd: number | null;
  txns24h: { buys: number; sells: number } | null;
  /** Aus einem SOL-quotierten Paar abgeleitet: priceUsd / priceNative. */
  solPriceUsd: number | null;
  /** Median des Token-Preises in SOL über SOL-quotierte Paare. */
  medianPriceNative: number | null;
  priceChangeH1Pct: number | null;
  priceChangeH6Pct: number | null;
  priceChangeH24Pct: number | null;
  /**
   * Geschätzte realisierte Tagesvolatilität in Prozent, aus den
   * Preisänderungen abgeleitet (`ml/volatility.ts`).
   *
   * Die Größe, die über den Nenner der LP-Rechnung entscheidet: Gebühren wachsen
   * linear mit dem Umschlag, der Verlust gegenüber Halten quadratisch mit ihr.
   */
  volatilityPctDaily: number | null;
  pairCount: number;
}

/** Gesamteingabe für Screening + Scoring eines Pool-Kandidaten. */
export interface ScreeningInput {
  presetKind: PresetKind;
  preset: PresetConfig;
  global: GlobalConfig;
  source: CandidateSource;
  pool: PoolMetrics;
  /** Nicht-SOL-Seite des Pools; null wenn der Pool nicht SOL-quotiert ist. */
  tokenMint: string | null;
  market: MarketAggregates | null;
  risk: TokenRiskReport | null;
  sellability: SellabilityCheck | null;
}

export type CheckStatus = "passed" | "failed" | "skipped";

export interface FilterCheck {
  id: string;
  status: CheckStatus;
  /** Gemessener Wert (für Scanner-Transparenz: "warum abgelehnt"). */
  value?: number | string | boolean | null;
  /** Angewandter Grenzwert. */
  limit?: number | string;
  detail?: string;
}

export interface ScoreComponent {
  id: string;
  points: number;
  max: number;
  detail?: string;
}

export interface ScoreBreakdown {
  total: number;
  components: ScoreComponent[];
}

export interface ScreeningResult {
  verdict: "accepted" | "rejected";
  checks: FilterCheck[];
  /** IDs der fehlgeschlagenen Checks (leer bei accepted). */
  rejectedBy: string[];
  /** Score wird auch für abgelehnte Kandidaten berechnet (Scanner/Analyse). */
  score: ScoreBreakdown;
  screenedAt: Date;
}
