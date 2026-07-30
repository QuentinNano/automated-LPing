import { z } from "zod";

/**
 * Laufzeit-Konfiguration des Bots (KONZEPT.md Abschnitt 14).
 *
 * Abgrenzung: Verbindungs-Secrets (RPC-URLs, DATABASE_URL) kommen aus der
 * Umgebung (.env) und sind bewusst NICHT Teil dieser versionierten, später
 * UI-editierbaren Konfiguration.
 */

const pct = (min: number, max: number) => z.number().min(min).max(max);

export const KillSwitchSchema = z.enum(["off", "pause", "flatten"]);
export type KillSwitch = z.infer<typeof KillSwitchSchema>;

/**
 * Annahmen der Paper-Simulation. Bewusst NUR On-Chain-Kosten: Infrastruktur
 * (VPS, RPC-Tarife) ist monatlicher Fixaufwand und keiner einzelnen Position
 * zurechenbar — sie würde den Preset-Vergleich verzerren statt ihn zu schärfen.
 */
export const PaperConfigSchema = z.object({
  /**
   * Virtuelles Kapital je Preset. Bewusst für alle Presets gleich, damit der
   * Vergleich fair ist (capitalSharePct steuert erst die spätere Live-Allokation).
   */
  capitalPerPresetSol: z.number().positive().max(10_000),
  costs: z.object({
    /** Geschätzte Priority Fee je Transaktion (Open/Claim/Rebalance/Close/Swap). */
    priorityFeeSol: z.number().min(0).max(0.5),
    /** Angenommener Slippage-/Preis-Impact-Verlust je Swap. */
    swapSlippagePct: pct(0, 10),
  }),
  /**
   * Sicherheitsabschlag auf den geschätzten Fee-Anteil: Wir kennen die
   * Liquiditätsverteilung anderer LPs nicht, deshalb wird der eigene Anteil
   * am Fee-Fluss konservativ nach unten korrigiert.
   */
  feeShareHaircutPct: pct(0, 90),
  /**
   * Angenommene Bin-Breite der **übrigen** LPs im Pool.
   *
   * Gebühren verdient nur der aktive Bin, und der Anteil daran ist
   * `eigene Liquidität dort / Gesamtliquidität dort`. Die fremde Verteilung ist
   * von außen nicht beobachtbar, also wird sie als gleichmäßig über diese
   * Bin-Zahl angenommen: Fremd-TVL / poolLiquidityBins liegt im aktiven Bin.
   *
   * Default 70 = die DLMM-Standardbreite einer Position
   * (`DEFAULT_BIN_PER_POSITION`, zugleich `MAX_BIN_PER_ARRAY`). Der Wert steuert
   * unmittelbar, wie stark sich Konzentration auszahlt — eine enge Curve-Position
   * gewinnt gegenüber einer breiten Spot-Position genau dann, wenn andere LPs
   * breiter liegen als sie selbst. Er gehört damit zu den Modellannahmen, die
   * die Sensitivitätsanalyse (KONZEPT-ML.md 6.1) prüfen muss.
   */
  poolLiquidityBins: z.number().int().min(1).max(1_400).default(70),
});

export type PaperConfig = z.infer<typeof PaperConfigSchema>;

export const GlobalConfigSchema = z
  .object({
    /** Paper-Trading ist der sichere Default; Live erst nach Phase 1. */
    paperTrading: z.boolean().default(true),
    killSwitch: KillSwitchSchema.default("off"),
    maxTotalExposureSol: z.number().positive().max(10_000),
    minSolReserve: z.number().min(0.1).max(100).default(0.5),
    maxOpenPositions: z.number().int().min(1).max(50).default(10),
    dailyLossLimitPct: pct(0.5, 50).default(5),
    hardLossLimitPct: pct(1, 80).default(10),
    priorityFeeCapLamports: z.number().int().min(0).max(1_000_000_000).default(2_000_000),
    profitSweepThresholdSol: z.number().min(0).default(5),
    paper: PaperConfigSchema,
  })
  .superRefine((val, ctx) => {
    if (val.hardLossLimitPct <= val.dailyLossLimitPct) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hardLossLimitPct"],
        message: "hardLossLimitPct muss größer als dailyLossLimitPct sein",
      });
    }
  });

export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;

export const StrategyConfigSchema = z.object({
  /** DLMM-Liquiditätsverteilung (SDK StrategyType). */
  type: z.enum(["Spot", "Curve", "BidAsk"]),
  /** quote_only = einseitig SOL unterhalb des aktiven Bins; balanced = 50/50. */
  sided: z.enum(["balanced", "quote_only"]),
});

export const ScreeningConfigSchema = z.object({
  maxTop10HolderPct: pct(1, 100),
  maxSingleHolderPct: pct(1, 100),
  maxInsiderPct: pct(0, 100),
  minHolders: z.number().int().min(0),
  maxPriceDivergencePct: pct(0.1, 20),
  maxPoolShareOfTvlPct: pct(0.1, 20),
  maxSingleLpDominancePct: pct(10, 100),
  /** RugCheck-normalisierter Risiko-Score (0–100, höher = riskanter). */
  maxNormalizedRiskScore: z.number().min(0).max(100),
  /** Wash-Trading-Heuristik: maximale plausible Durchschnitts-Trade-Größe. */
  maxAvgTradeUsd: z.number().positive(),
});

/** Vor-Filter der Discovery (KONZEPT.md Abschnitt 4.2). */
export const DiscoveryConfigSchema = z.object({
  minBinStep: z.number().int().min(1).max(400),
  minBaseFeePct: z.number().min(0).max(15),
});

export const FeeHarvestConfigSchema = z.object({
  claimIntervalMin: z.number().int().min(5).max(24 * 60),
  /** Anteil geclaimter Token-Fees, der sofort in SOL konvertiert wird. */
  convertToSolPct: pct(0, 100),
  minClaimValueSol: z.number().min(0),
  /** Claim erst, wenn unclaimed Fees >= claimCostFactor × geschätzte Tx-Kosten. */
  claimCostFactor: z.number().min(1).max(100),
  /** Mindest-Swapgröße; kleinere Beträge sammeln sich im Dust-Ledger. */
  dustThresholdSol: z.number().min(0),
});

export const RebalanceConfigSchema = z.object({
  enabled: z.boolean(),
  /** Abstand vom Range-Rand (in % der Range-Breite), der den Trigger auslöst. */
  bufferPct: pct(1, 40),
  cooldownMin: z.number().int().min(0),
  maxPerDay: z.number().int().min(0).max(48),
  /** Erwartete Zusatz-Fees müssen die Rebalance-Kosten um diesen Faktor übersteigen. */
  minEvFactor: z.number().min(1).max(20),
});

export const EmergencyConfigSchema = z.object({
  priceDropPct5m: pct(5, 95),
  tvlDropPct10m: pct(5, 95),
  sellImpactMaxPct: pct(1, 95),
});

export const PresetConfigSchema = z
  .object({
    /** Anzeigename in der UI (der Objekt-Schlüssel ist die technische ID). */
    label: z.string().min(1).max(40),
    enabled: z.boolean().default(true),
    capitalSharePct: pct(0, 100),
    positionSizePct: pct(0.05, 10),
    maxPositions: z.number().int().min(0).max(25),
    minScore: z.number().min(0).max(100),
    minTvlUsd: z.number().min(0),
    tokenAgeHours: z
      .object({ min: z.number().min(0), max: z.number().positive().optional() })
      .refine((v) => v.max === undefined || v.max > v.min, {
        message: "tokenAgeHours.max muss größer als min sein",
      }),
    volTvlBounds: z
      .object({ min: z.number().min(0), max: z.number().positive() })
      .refine((v) => v.max > v.min, { message: "volTvlBounds.max muss größer als min sein" }),
    screening: ScreeningConfigSchema,
    discovery: DiscoveryConfigSchema,
    strategy: StrategyConfigSchema,
    binRange: z
      .object({ min: z.number().int().min(1).max(400), max: z.number().int().min(1).max(400) })
      .refine((v) => v.max >= v.min, { message: "binRange.max muss >= min sein" }),
    feeHarvest: FeeHarvestConfigSchema,
    compound: z.object({ enabled: z.boolean(), minSol: z.number().min(0) }),
    stopLossPct: pct(1, 90),
    takeProfitPct: pct(1, 10_000).optional(),
    maxHoldHours: z.number().min(1).max(24 * 90),
    rebalance: RebalanceConfigSchema,
    slippageCapPct: pct(0.1, 10),
    emergency: EmergencyConfigSchema,
  })
  .superRefine((val, ctx) => {
    if (val.compound.enabled && val.feeHarvest.convertToSolPct >= 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["compound", "enabled"],
        message: "Compounding erfordert convertToSolPct < 100 (es bleibt sonst nichts zum Reinvestieren)",
      });
    }
  });

export type PresetConfig = z.infer<typeof PresetConfigSchema>;

/**
 * Preset-IDs sind frei wählbar (Default: konservativ, balanced, degen) —
 * so lassen sich beliebig viele Risikoprofile parallel im Paper-Trading
 * gegeneinander testen.
 */
export type PresetKind = string;

const PRESET_ID_RE = /^[a-z][a-z0-9_]{1,23}$/;

export const BotConfigSchema = z
  .object({
    global: GlobalConfigSchema,
    presets: z.record(z.string(), PresetConfigSchema),
  })
  .superRefine((val, ctx) => {
    const entries = Object.entries(val.presets);
    if (entries.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["presets"],
        message: "Mindestens ein Preset erforderlich",
      });
      return;
    }

    let share = 0;
    for (const [id, preset] of entries) {
      if (!PRESET_ID_RE.test(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presets", id],
          message: "Preset-ID muss aus Kleinbuchstaben/Ziffern/_ bestehen (2–24 Zeichen)",
        });
      }
      if (preset.enabled) share += preset.capitalSharePct;
      if (preset.maxPositions > val.global.maxOpenPositions) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presets", id, "maxPositions"],
          message: "Preset-maxPositions darf global.maxOpenPositions nicht überschreiten",
        });
      }
    }
    if (share > 100) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["presets"],
        message: `Summe der capitalSharePct aktiver Presets (${share}) darf 100 nicht überschreiten`,
      });
    }
  });

export type BotConfig = z.infer<typeof BotConfigSchema>;

/** Ergebnisorientierte Parse-Hilfe mit lesbaren Fehlermeldungen. */
export function parseBotConfig(input: unknown): BotConfig {
  const parsed = BotConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigValidationError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  return parsed.data;
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Ungültige Konfiguration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigValidationError";
  }
}
