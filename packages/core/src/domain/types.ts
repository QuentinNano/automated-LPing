/**
 * Normalisierte Domänentypen. Adapter übersetzen die jeweiligen Roh-Antworten
 * (Meteora, DexScreener, RugCheck, Jupiter, Fabriq) in diese Formen, damit
 * Screening/Scoring quellenunabhängig arbeiten können.
 */

export interface TokenRef {
  mint: string;
  symbol?: string;
  decimals?: number;
}

/** Pool-Kennzahlen aus der Meteora-DLMM-API. */
export interface PoolMetrics {
  poolAddress: string;
  name?: string;
  mintX: string;
  mintY: string;
  binStep: number;
  baseFeePct?: number;
  maxFeePct?: number;
  tvlUsd?: number;
  volume24hUsd?: number;
  fees24hUsd?: number;
  /** fees24h / tvl in %, sofern beide Werte vorliegen. */
  feeTvl24hPct?: number;
  priceNative?: number;
  apr?: number;
  apy?: number;
  fetchedAt: Date;
  source: "meteora";
}

/** Markt-Querschnitt eines Handelspaars (DexScreener). */
export interface MarketPairSnapshot {
  pairAddress: string;
  dexId?: string;
  baseToken: TokenRef;
  quoteToken: TokenRef;
  priceUsd?: number;
  priceNative?: number;
  liquidityUsd?: number;
  volume: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h6?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  fdvUsd?: number;
  marketCapUsd?: number;
  pairCreatedAt?: Date;
  fetchedAt: Date;
  source: "dexscreener";
}

/** Token-Risiko-Report (RugCheck), tri-state: null = Information nicht verfügbar. */
export interface TokenRiskReport {
  mint: string;
  /** RugCheck-Rohscore (höher = riskanter). */
  rawScore: number | null;
  /** Normalisierter Score 0–100 (höher = riskanter), sofern geliefert. */
  normalizedScore: number | null;
  risks: { name: string; level?: string; score?: number; description?: string }[];
  mintAuthorityRevoked: boolean | null;
  freezeAuthorityRevoked: boolean | null;
  topHolders: { address: string; pct: number; insider: boolean }[];
  top10HolderPct: number | null;
  insiderPct: number | null;
  totalHolders: number | null;
  totalMarketLiquidityUsd: number | null;
  fetchedAt: Date;
  source: "rugcheck";
}

/** Ein Jupiter-Quote (Beträge als Roh-Strings in Basiseinheiten). */
export interface SwapQuote {
  inputMint: string;
  outputMint: string;
  inAmountRaw: string;
  outAmountRaw: string;
  priceImpactPct: number | null;
  routeHops: number;
  fetchedAt: Date;
  source: "jupiter";
}

/** Ergebnis der Honeypot-/Verkaufbarkeitsprüfung (Quote in beide Richtungen). */
export interface SellabilityCheck {
  mint: string;
  buyOk: boolean;
  sellOk: boolean;
  buyImpactPct: number | null;
  sellImpactPct: number | null;
  /** Verlust eines hypothetischen Sofort-Roundtrips SOL→Token→SOL in %. */
  roundTripLossPct: number | null;
  verdict: "sellable" | "illiquid" | "blocked";
  checkedAt: Date;
}

/**
 * Token-Kennzahlen aus der Jupiter Token API v2. `null` heißt durchgängig
 * "nicht bekannt", nie "unbedenklich".
 */
export interface TokenOrganics {
  mint: string;
  /** 0–100; höher = organischere Aktivität. */
  organicScore: number | null;
  organicScoreLabel: "high" | "medium" | "low" | null;
  holderCount: number | null;
  isVerified: boolean | null;
  mintAuthorityDisabled: boolean | null;
  freezeAuthorityDisabled: boolean | null;
  topHoldersPct: number | null;
  fdvUsd: number | null;
  liquidityUsd: number | null;
  tags: string[];
  fetchedAt: Date;
  source: "jupiter-tokens";
}

export interface AdapterHealth {
  adapter: string;
  ok: boolean;
  latencyMs: number | null;
  note?: string;
}

/**
 * Discovery-Herkunft eines Kandidaten (KONZEPT.md Abschnitt 4). Das Preset
 * wird separat geführt, damit beliebig viele Presets dieselbe Quelle nutzen.
 */
export type CandidateSource = "fabriq" | "replicated";

export interface FabriqPool {
  poolAddress: string;
  score?: number;
  name?: string;
  /** Unveränderte Roh-Daten für Debugging/Schema-Drift-Analyse. */
  raw: unknown;
}

export type FabriqStatus = "ok" | "unavailable" | "schema_drift";

export interface FabriqTrendingResult {
  status: FabriqStatus;
  category: "degen" | "multiday";
  pools: FabriqPool[];
  note?: string;
}
