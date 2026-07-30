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

export { METRIC_WINDOWS, feeCurrencyOf } from "./domain/types";
export type {
  TokenRef,
  PoolMetrics,
  PoolTokenInfo,
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
  strategyWeights,
  openBins,
  applyPriceMove,
  totalsOf,
  isInRange,
} from "./paper/bins";
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
