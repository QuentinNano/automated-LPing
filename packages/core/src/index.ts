export {
  BotConfigSchema,
  GlobalConfigSchema,
  PresetConfigSchema,
  ScreeningConfigSchema,
  FeeHarvestConfigSchema,
  RebalanceConfigSchema,
  EmergencyConfigSchema,
  StrategyConfigSchema,
  KillSwitchSchema,
  parseBotConfig,
  ConfigValidationError,
  PRESET_KINDS,
} from "./config/schema";
export type {
  BotConfig,
  GlobalConfig,
  PresetConfig,
  PresetKind,
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

export type {
  TokenRef,
  PoolMetrics,
  MarketPairSnapshot,
  TokenRiskReport,
  SwapQuote,
  SellabilityCheck,
  AdapterHealth,
  CandidateSource,
  FabriqPool,
  FabriqStatus,
  FabriqTrendingResult,
} from "./domain/types";
