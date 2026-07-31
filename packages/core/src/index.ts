export {
  BotConfigSchema,
  GlobalConfigSchema,
  PresetConfigSchema,
  ScreeningConfigSchema,
  DiscoveryConfigSchema,
  FeeHarvestConfigSchema,
  RebalanceConfigSchema,
  EmergencyConfigSchema,
  StrategyConfigSchema,
  PaperConfigSchema,
  ExitConfigSchema,
  KillSwitchSchema,
  parseBotConfig,
  ConfigValidationError,
} from "./config/schema";
export type {
  BotConfig,
  GlobalConfig,
  PresetConfig,
  PresetKind,
  PaperConfig,
  ExitConfig,
  KillSwitch,
} from "./config/schema";

export { deepMerge } from "./config/merge";

export { ConfigService, MemoryConfigStore } from "./config/service";
export type {
  ConfigStore,
  StoredConfig,
  AppendConfigInput,
  ConfigChangeListener,
} from "./config/service";

export {
  LIFECYCLE_STATES,
  TERMINAL_STATES,
  TRIGGERS,
  allowedTransitions,
  canTransition,
  assertTransition,
  InvalidTransitionError,
} from "./lifecycle/states";
export type { LifecycleState, TransitionTrigger } from "./lifecycle/states";

export {
  marketTickFromPool,
  marketTickFromPoint,
  trackPointFromPool,
  poolFeePct,
  volumeRate24hUsd,
  volumeRate24hUsdSlow,
} from "./paper/ticks";
export type { TickPool } from "./paper/ticks";

export { replayPosition, replayEntries, summarizeReplay } from "./replay/engine";
export type {
  ReplayPool,
  ReplayOptions,
  ReplaySweepOptions,
  ReplayPosition,
  ReplayCloseReason,
  ReplaySummary,
} from "./replay/engine";

export {
  METRIC_WINDOWS,
  HISTORY_TIMEFRAMES,
  TIMEFRAME_MINUTES,
  candleFeePct,
  candleVolumeRate24hUsd,
  feeCurrencyOf,
} from "./domain/types";
export type {
  TokenRef,
  PoolMetrics,
  PoolTokenInfo,
  PoolCandle,
  HistoryTimeframe,
  CollectFeeMode,
  MetricWindow,
  WindowedMetric,
  MarketPairSnapshot,
  TokenRiskReport,
  SwapQuote,
  SellabilityCheck,
  AdapterHealth,
  CandidateSource,
  TokenOrganics,
  FabriqPool,
  FabriqStatus,
  FabriqTrendingResult,
} from "./domain/types";

export { WSOL_MINT, USDC_MINT, LAMPORTS_PER_SOL } from "./domain/constants";

export {
  aggregateMarket,
  tokenSideOf,
  poolPriceInSol,
  solPriceUsdOf,
  priceDivergencePct,
} from "./screening/aggregate";
export { runHardFilters } from "./screening/filters";
export { computeScore } from "./screening/score";
export { screenCandidate } from "./screening/screen";
export type {
  MarketAggregates,
  ScreeningInput,
  ScreeningResult,
  FilterCheck,
  CheckStatus,
  ScoreBreakdown,
  ScoreComponent,
} from "./screening/types";

export {
  classifyForPreset,
  shortlistRank,
  minTvlAcrossPresets,
  DISCOVERY_THRESHOLD_FACTOR,
} from "./discovery/replicate";
export type { ClassifyResult } from "./discovery/replicate";

export { DISCOVERY_STRATEGIES, buildDiscoveryFilter } from "./discovery/query";
export type { DiscoveryStrategy } from "./discovery/query";

export {
  binPrice,
  binIdFromPrice,
  deriveBinCount,
  deriveBinWidth,
  binsForCoverage,
  coverageHorizonHours,
  strategyWeights,
  openBins,
  applyPriceMove,
  activeBinValueSol,
  inRangeShare,
  totalsOf,
  isInRange,
} from "./paper/bins";
export type { BinWidth, DeriveBinWidthParams } from "./paper/bins";
export {
  openPaperPosition,
  tickPaperPosition,
  valuePosition,
  closePaperPosition,
} from "./paper/engine";
export type {
  SimBin,
  PaperPositionState,
  MarketTick,
  PaperCloseReason,
  PaperValuation,
  PaperTickResult,
  PresetPerformance,
} from "./paper/types";
export type { OpenPaperPositionParams, PaperCloseResult } from "./paper/engine";
export {
  evaluatePoolExit,
  recordObservation,
  poolFeeRatePctPerDay,
} from "./paper/poolHealth";
export type { PoolObservation, PoolExitReason, PoolHealthInput } from "./paper/poolHealth";
export {
  positionSizeSol,
  deployedCapitalSol,
  fixedCostSol,
  assessSize,
  assessSizes,
  RENT_BINDING_SOL,
  BIN_ARRAY_INIT_SOL,
} from "./paper/sizing";
export type { SizeViability, SizeWarning } from "./paper/sizing";
export {
  realizedVolatilityPctDaily,
  estimateVolatilityPctDaily,
  feeYieldPerVariance,
} from "./ml/volatility";

export {
  FEATURE_VERSION,
  FEATURE_KEYS,
  buildFeatureVector,
  featureHeader,
  featureRow,
} from "./ml/features";
export type { FeatureVector, FeatureValue, FeatureInput } from "./ml/features";
export {
  OUTCOME_HORIZONS_HOURS,
  TRACKING_DURATION_HOURS,
  computeOutcomes,
  effectiveFeePct,
  trackingIntervalSec,
} from "./ml/outcomes";
export type {
  OutcomeLabel,
  OutcomeHorizon,
  SnapshotWindows,
  TrackPoint,
} from "./ml/outcomes";
export { evaluateTrackHealth, overallHealth } from "./ml/health";
export type { HealthCheck, HealthStatus, TrackHealthInput } from "./ml/health";
