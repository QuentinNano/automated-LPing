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

/**
 * Zeitfenster, die die Meteora-Pool-API je Kennzahl liefert
 * (`30m`, `1h`, `2h`, `4h`, `12h`, `24h`).
 *
 * Warum alle Fenster geführt werden: KONZEPT-ML.md 3.2/4.2 stützt sich auf
 * Trends und Stetigkeit ("Fee/TVL-Trend statt nur -Niveau"), nicht auf das
 * 24-Stunden-Niveau allein. Die Werte kommen im selben Response — sie später
 * nachzuholen ist unmöglich, weil es keine Historie zum Abrufen gibt.
 */
export const METRIC_WINDOWS = ["m30", "h1", "h2", "h4", "h12", "h24"] as const;
export type MetricWindow = (typeof METRIC_WINDOWS)[number];
export type WindowedMetric = Partial<Record<MetricWindow, number>>;

/**
 * Gebühren-Währung eines Pools (`collect_fee_mode` in `pool_config`).
 * - `input_only` (0): Gebühr im Input-Token des Swaps, folgt also der Richtung.
 * - `only_y` (1): Gebühr immer in Token Y, auch wenn Y der Output ist.
 */
export type CollectFeeMode = "input_only" | "only_y";

/** Token-Angaben, die die Pool-API bereits mitliefert (kein Extra-Request). */
export interface PoolTokenInfo {
  mint: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  holders?: number;
  isVerified?: boolean;
  /**
   * Aus der Pool-API. Achtung: `true` heißt "Freeze-Authority entzogen".
   * Fehlt das Feld, bleibt es `undefined` — nie als "unbedenklich" lesen.
   */
  freezeAuthorityDisabled?: boolean;
  priceUsd?: number;
  marketCapUsd?: number;
  totalSupply?: number;
}

/** Pool-Kennzahlen aus der Meteora-DLMM-API. */
export interface PoolMetrics {
  poolAddress: string;
  name?: string;
  mintX: string;
  mintY: string;
  binStep: number;
  /** Basisgebühr (Mindestgebühr) in %. */
  baseFeePct?: number;
  /** Obergrenze der Gesamtgebühr in %. */
  maxFeePct?: number;
  /**
   * Aktuelle Gesamtgebühr = Basisgebühr + volatilitätsabhängige Zusatzgebühr.
   * Das ist der Satz, mit dem Swaps tatsächlich belastet werden; `baseFeePct`
   * ist nur die Untergrenze und unterschätzt volatile Pools erheblich.
   */
  dynamicFeePct?: number;
  /**
   * Protokollanteil an der Handelsgebühr in % **der Gebühr** (nicht des
   * Volumens). Standard-Pools 10 %, Launch-Pools 20 % — der LP erhält nur den
   * Rest. Ohne diesen Abzug wird der Fee-Ertrag systematisch zu hoch angesetzt.
   */
  protocolFeePct?: number;
  collectFeeMode?: CollectFeeMode;
  tvlUsd?: number;
  /** Volumen je Zeitfenster in USD. */
  volumeUsd: WindowedMetric;
  /** Gesamt-Handelsgebühren je Zeitfenster in USD (vor Protokollabzug). */
  feesUsd: WindowedMetric;
  /** Gebühren/TVL je Zeitfenster in %. */
  feeTvlPct: WindowedMetric;
  /** Protokollanteil der Gebühren je Zeitfenster in USD. */
  protocolFeesUsd: WindowedMetric;
  /**
   * 24-Stunden-Kürzel. Spiegeln `volumeUsd.h24` / `feesUsd.h24` /
   * `feeTvlPct.h24` und werden ausschließlich im Adapter gesetzt — sie
   * existieren, damit die bestehenden Filter- und Score-Pfade unverändert
   * bleiben, nicht als zweite Wahrheit.
   */
  volume24hUsd?: number;
  fees24hUsd?: number;
  feeTvl24hPct?: number;
  priceNative?: number;
  apr?: number;
  apy?: number;
  /** Liquidity-Mining: zusätzlicher Ertrag, der neben den Gebühren anfällt. */
  hasFarm?: boolean;
  farmApr?: number;
  farmApy?: number;
  /** Reward-Mints ohne Platzhalter-Adressen. */
  rewardMints: string[];
  tags: string[];
  launchpad?: string;
  /** Erstellungszeitpunkt des Pools (nicht des Tokens). */
  poolCreatedAt?: Date;
  tokenX?: PoolTokenInfo;
  tokenY?: PoolTokenInfo;
  fetchedAt: Date;
  source: "meteora";
}

/**
 * In welcher Währung die Gebühren dieses Pools anfallen — die Frage, die über
 * das Token-Exposure geclaimter Gebühren entscheidet (KONZEPT.md 8.3).
 *
 * `only_y` allein sagt nichts: Es kommt darauf an, ob SOL Token Y ist. Steht
 * SOL auf der X-Seite, kehrt derselbe Modus den Vorteil ins Gegenteil, weil
 * dann alle Gebühren im Memecoin anfallen.
 */
export function feeCurrencyOf(
  pool: Pick<PoolMetrics, "mintX" | "mintY" | "collectFeeMode">,
  quoteMint: string,
): "quote" | "base" | "mixed" | null {
  if (pool.collectFeeMode === undefined) return null;
  if (pool.collectFeeMode === "input_only") return "mixed";
  return pool.mintY === quoteMint ? "quote" : "base";
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
