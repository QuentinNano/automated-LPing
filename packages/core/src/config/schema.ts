import { z } from "zod";
import { binsForCoverage, coverageHorizonHours } from "../paper/bins";

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
   * Angenommener Anteil der Handelsgebühr, den **Limit-Order-Liquidität**
   * abzweigt — auf Pools, die Limit Orders unterstützen.
   *
   * Seit `lb_clmm` 0.12.0 (Mainnet Mai 2026) ist jeder bestehende Pool **ohne
   * Liquidity-Mining-Rewards** unumkehrbar ein Limit-Order-Pool. Das ist
   * praktisch jeder Memecoin-Pool, den die Presets suchen. Dort teilt das
   * Programm die Gebühr zuerst nach Liquiditätsquelle auf: Was Limit Orders
   * gefüllt haben, geht je zur Hälfte an die Order-Steller und ans Protokoll —
   * an Market-Maker-LPs davon nichts.
   *
   * Bewusst **getrennt** von `feeShareHaircutPct`: Beide senken den Ertrag,
   * aber sie haben verschiedene Ursachen und verschiedene Messwege. In einem
   * Sammel-Abschlag zusammengefasst ließe sich keiner von beiden je ersetzen.
   * Dieser hier wird durch eine Auswertung der `/positions/.../historical`-
   * Events messbar; der andere braucht den RPC-Adapter.
   *
   * Der Startwert ist eine Annahme, kein Messwert, und gehört deshalb in den
   * Stresstest — nicht in eine Optimierung (KONZEPT-ML.md 6.1).
   */
  limitOrderShareHaircutPct: pct(0, 90).default(15),
  /**
   * Preisimpact eines Swaps je Anteil am Pool-TVL.
   *
   * Die Slippage war eine **Pauschale**: derselbe Prozentsatz, ob 0,1 oder 5
   * SOL durch einen Pool gehen. Das ist gerade dort falsch, wo es weh tut — im
   * Ausstieg aus einer Position, die für ihren Pool zu groß geworden ist, und
   * damit genau im Verlust-Tail, den die Simulation abbilden soll.
   *
   * Modell: `Impact% = swapImpactFactor · (Swap-Wert / Pool-TVL) · 100`, additiv
   * zur Grundslippage und gedeckelt durch `slippageCapPct` des Presets. Bei 0,5
   * kostet ein Swap über 1 % des TVL zusätzlich 0,5 %.
   *
   * Ersetzbar durch eine Messung: Die Jupiter-Sellability-Prüfung ermittelt je
   * Kandidat bereits einen Roundtrip-Verlust — bislang nur als Filter, nicht als
   * Kalibrierung. `0` schaltet die Größenabhängigkeit ab.
   */
  swapImpactFactor: z.number().min(0).max(20).default(0.5),
  /**
   * Angenommene Bin-Breite der **übrigen** LPs im Pool.
   *
   * Gebühren verdient nur der aktive Bin, und der Anteil daran ist
   * `eigene Liquidität dort / Gesamtliquidität dort`. Die fremde Verteilung ist
   * von außen nicht beobachtbar, also wird sie als gleichmäßig über diese
   * Bin-Zahl angenommen: Fremd-TVL / poolLiquidityBins liegt im aktiven Bin.
   *
   * **Der Wert skaliert die gesamte Ertragsseite der Simulation linear** — er ist
   * damit die folgenreichste Einzelannahme des Modells (KONZEPT-ML.md 6.1) und
   * gehört an den Anfang jeder Sensitivitätsanalyse (`pnpm stress`).
   *
   * Default 30, nicht 70: Die DLMM-Standardbreite einer Position (70 Bins) wäre
   * die richtige Annahme, wenn fremde LPs typische Default-Positionen hielten.
   * Auf volatilen Memecoin-Pools konzentrieren sie sich erfahrungsgemäß deutlich
   * enger um den Preis, was den eigenen Anteil am aktiven Bin senkt. Das eigene
   * Prinzip — Modellannahmen auf dem konservativen Ende festsetzen statt sie zu
   * optimieren (KONZEPT-ML.md 6.1) — verlangt hier den niedrigeren Wert. Ersetzt
   * wird die Schätzung erst durch eine Messung über den RPC-Adapter.
   */
  poolLiquidityBins: z.number().int().min(1).max(1_400).default(30),
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
  /**
   * Erwartete Zusatz-Fees müssen die Rebalance-Kosten um diesen Faktor
   * übersteigen.
   *
   * Achtung beim Nachjustieren: Der Faktor wirkt nur zusammen mit
   * `projectionHours`. Frühere Werte von 2–3 standen gegen eine Ertragsschätzung,
   * die um Größenordnungen zu hoch lag (ANALYSE.md 4.1) — mit der korrigierten
   * Schätzung hätten sie das Rebalancing praktisch abgeschaltet.
   */
  minEvFactor: z.number().min(1).max(20),
  /**
   * Zeitraum, über den der Zusatzertrag eines Rebalances projiziert wird.
   *
   * **Eine Modellannahme, kein Strategieparameter.** Sie beantwortet die Frage
   * „wie lange bleibt eine nachzentrierte Position nutzbar zentriert?", und die
   * hängt an der Volatilität, die das Modell nicht kennt. Vorher war sie implizit
   * die gesamte Restlaufzeit — bei Konservativ bis zu 336 Stunden —, was jede
   * Rebalance-Entscheidung durchwinkte.
   *
   * Sie gehört damit in die Sensitivitätsanalyse (`pnpm stress`) und wird dort
   * am konservativen Ende festgesetzt, nicht optimiert (KONZEPT-ML.md 6.1).
   */
  projectionHours: z.number().min(0.5).max(72).default(12),
});

export const EmergencyConfigSchema = z.object({
  priceDropPct5m: pct(5, 95),
  tvlDropPct10m: pct(5, 95),
  sellImpactMaxPct: pct(1, 95),
});

/**
 * Zustandsabhängige Ausstiegsregeln (KONZEPT.md 9).
 *
 * Sie ersetzen den Take-Profit, der für eine DLMM-Position keinen Sinn ergibt:
 * Der Preisgewinn einer Position ist durch ihre Range gedeckelt — bei den
 * ausgelieferten Presets auf +1 bis +2 % —, während die Take-Profit-Schwellen
 * bei 30–50 % lagen. Sie konnten deshalb nie auslösen, und es blieb ein
 * einseitiges Regelwerk übrig, das Verluste kappt und Gewinne nie mitnimmt.
 * Der Median-PnL war infolgedessen fast exakt der eingestellte Stop-Loss
 * (ANALYSE.md 2).
 *
 * Die richtige Frage an eine LP-Position ist nicht „hat sie genug gewonnen?",
 * sondern **„verdient sie noch, und ist der Ausstieg noch möglich?"**. Genau das
 * prüfen diese Regeln:
 *
 * - **Risiko-Exits** (`priceCrash`, `tvlDrain`): Die Fähigkeit auszusteigen
 *   schwindet, bevor der PnL es zeigt.
 * - **Ertrags-Exits** (`feeCollapse`, `feeStall`): Kapital, das nichts mehr
 *   verdient, trägt weiter Impermanent-Loss-Risiko. Es gehört heraus.
 *
 * Abgrenzung zu `emergency`: Jene Schwellen gehören dem (noch offenen) Live-Risk
 * Manager und brauchen Quellen, die die Simulation nicht hat — insbesondere die
 * Verkaufbarkeitsprüfung über Jupiter. Was allein aus dem Marktbeobachtungs-Tick
 * entscheidbar ist, steht hier und wird von der Engine tatsächlich ausgewertet.
 */
export const ExitConfigSchema = z.object({
  /** Preissturz im Fenster `priceWindowMin`, gemessen vom Fensterhoch. */
  priceCrashPct: pct(5, 95),
  priceWindowMin: z.number().int().min(5).max(24 * 60),
  /** TVL-Rückgang im Fenster `tvlWindowMin`, gemessen vom Fensterhoch. */
  tvlDrainPct: pct(5, 95),
  tvlWindowMin: z.number().int().min(5).max(24 * 60),
  /**
   * Rückgang der **Gebührenertragsrate des Pools** (Gebühren je TVL und Tag)
   * gegenüber dem Stand beim Eröffnen, in Prozent. 70 heißt: Fällt die Rate auf
   * unter 30 % des Einstiegsniveaus, verdient der Pool nicht mehr genug.
   */
  feeCollapsePct: pct(10, 99),
  /**
   * Zeitfenster ohne nennenswerten **eigenen** Gebührenertrag, nach dem die
   * Position als totes Kapital gilt. Anders als `feeCollapse` misst das nicht den
   * Pool, sondern die Position — es greift damit auch, wenn der Pool floriert und
   * nur die eigene Range danebenliegt.
   */
  feeStallHours: z.number().min(0.5).max(24 * 14),
  /** Untergrenze, ab der Ertrag als „nennenswert" gilt (% des Einsatzes je Tag). */
  feeStallMinPctPerDay: pct(0, 100),
});

export const PresetConfigSchema = z
  .object({
    /** Anzeigename in der UI (der Objekt-Schlüssel ist die technische ID). */
    label: z.string().min(1).max(40),
    enabled: z.boolean().default(true),
    capitalSharePct: pct(0, 100),
    /**
     * Einsatz je Position in SOL — **absolut, nicht als Anteil**.
     *
     * Vorher ein Prozentsatz, dessen Bezugsgröße an drei Stellen unterschiedlich
     * gewählt war (Paper-Engine und Replay gegen `paper.capitalPerPresetSol`,
     * der Screening-Filter gegen `global.maxTotalExposureSol` — Faktor 2
     * Unterschied, ANALYSE.md 4.2). Ein absoluter Betrag hat nur eine Lesart.
     *
     * Die Untergrenze ist keine Geschmacksfrage: Eine Position bindet ~0,057 SOL
     * Rent und kann eine nicht erstattete Bin-Array-Initialisierung von ~0,07 SOL
     * auslösen. Unterhalb von etwa 1 SOL tragen diese Fixkosten die Position
     * nicht mehr — sie sind dort zweistellige Prozentsätze des Einsatzes.
     */
    positionSizeSol: z.number().min(0.5).max(1_000),
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
    /**
     * Zulässige realisierte Tagesvolatilität des Tokens in Prozent.
     *
     * Die bislang fehlende Größe der Auswahl. Gebühren wachsen linear mit dem
     * Umschlag, der Impermanent Loss aber quadratisch mit der Volatilität —
     * weshalb ein Pool mit hoher Fee/TVL-Rate nicht automatisch ein guter Pool
     * ist. Gemessen kippt der Ertrag zwischen σ 20 % und σ 40 % pro Tag
     * (ANALYSE.md 3.2), während der Score bis dahin keinen einzigen
     * Volatilitätsterm enthielt.
     *
     * Eine **Obergrenze** ist der eigentliche Punkt; die Untergrenze verhindert
     * nur, dass tote Pools durchrutschen.
     */
    volatilityBoundsPctDaily: z
      .object({ min: z.number().min(0), max: z.number().positive() })
      .refine((v) => v.max > v.min, {
        message: "volatilityBoundsPctDaily.max muss größer als min sein",
      }),
    screening: ScreeningConfigSchema,
    discovery: DiscoveryConfigSchema,
    strategy: StrategyConfigSchema,
    /**
     * Breite der Position in Bins.
     *
     * `min`/`max` sind **Grenzen**, nicht der Wert. Ist `coverageSigmas` gesetzt
     * und die Volatilität bekannt, wird die Breite daraus hergeleitet und in
     * diese Grenzen gezwungen; sonst gilt weiter die Mitte.
     */
    binRange: z
      .object({
        min: z.number().int().min(1).max(1_400),
        max: z.number().int().min(1).max(1_400),
        /**
         * Wie viele Standardabweichungen der Preisbewegung die Range abdecken
         * soll.
         *
         * **Der Parameter, der die Range an den Markt bindet statt an eine
         * Zahl.** Eine feste Bin-Zahl bedeutet bei ruhigem Token eine sinnvolle
         * Range und bei einem wilden eine, die binnen Stunden verlassen ist —
         * die ausgelieferten Presets umspannten 13 bis 28 % bei Token, deren
         * Tagesvolatilität 40 bis 150 % beträgt. Die Position war dann die
         * meiste Zeit außerhalb, verdiente nichts und trug trotzdem den vollen
         * Impermanent Loss (ANALYSE.md 3).
         *
         * Herleiten statt optimieren, im Sinne von KONZEPT-ML.md 6.1: Die
         * Abdeckung ist eine fachliche Entscheidung, die Bin-Zahl folgt daraus.
         */
        coverageSigmas: z.number().min(0.25).max(10).optional(),
      })
      .refine((v) => v.max >= v.min, { message: "binRange.max muss >= min sein" }),
    feeHarvest: FeeHarvestConfigSchema,
    compound: z.object({ enabled: z.boolean(), minSol: z.number().min(0) }),
    /**
     * Harte Verlustgrenze — **Rückfalllinie, nicht primärer Ausstieg.**
     *
     * Die zustandsabhängigen Regeln in `exit` sollen früher greifen. Der
     * PnL-Stop bleibt trotzdem, weil er als einziger keine Annahme über den
     * Mechanismus macht: In einem Dump steigen Volumen und Gebühren, und der TVL
     * kann sogar steigen, weil Farmer Liquidität nachlegen. Die Pool-Parameter
     * sehen dann **besser** aus, während die Position ausblutet — ein rein
     * parameterbasierter Ausstieg wäre genau dort blind, wo es darauf ankommt.
     */
    stopLossPct: pct(1, 90),
    maxHoldHours: z.number().min(1).max(24 * 90),
    rebalance: RebalanceConfigSchema,
    slippageCapPct: pct(0.1, 10),
    exit: ExitConfigSchema,
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

    // Trägt `binRange.max` die zugelassene Volatilität überhaupt?
    //
    // Die Leitplanke darf begrenzen, was Kosten und Kapitalbindung tragen — sie
    // darf die Herleitung aber nicht ersetzen. Deckt sie am oberen Rand des
    // erlaubten Volatilitätsbands nicht einmal **eine** Standardabweichung ab,
    // ist die Position dort strukturell zu eng: Sie verlässt die Range binnen
    // Stunden, verdient nichts mehr und trägt trotzdem den vollen Impermanent
    // Loss. Genau dieser Fall lief bisher lautlos in die Klemmung.
    //
    // 1σ ist bewusst eine Untergrenze und nicht `coverageSigmas`: Die volle
    // Abdeckung am Extremrand zu verlangen, erzwänge Ranges, deren Bin-Arrays
    // teurer sind als der Nutzen. Der schmalste zugelassene Bin Step ist der
    // ungünstigste Fall — je feiner die Bins, desto mehr braucht dieselbe
    // Preisspanne.
    if (val.binRange.coverageSigmas !== undefined) {
      const needed = binsForCoverage({
        sigmas: 1,
        volatilityPctDaily: val.volatilityBoundsPctDaily.max,
        binStep: val.discovery.minBinStep,
        horizonHours: coverageHorizonHours(val),
        sided: val.strategy.sided,
      });
      if (needed !== null && needed > val.binRange.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["binRange", "max"],
          message:
            `binRange.max ${val.binRange.max} deckt bei ` +
            `volatilityBoundsPctDaily.max ${val.volatilityBoundsPctDaily.max} %/Tag und ` +
            `discovery.minBinStep ${val.discovery.minBinStep} keine volle Standardabweichung ab ` +
            `(nötig: ${needed} Bins). Entweder binRange.max anheben, ` +
            `volatilityBoundsPctDaily.max senken oder discovery.minBinStep erhöhen`,
        });
      }
    }
  });

export type ExitConfig = z.infer<typeof ExitConfigSchema>;
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

      // Ein Preset, das seine Positionen nicht alle finanzieren kann, liefert
      // stillschweigend weniger Beobachtungen als konfiguriert — der Vergleich
      // misst dann Kapitalmangel statt Strategiegüte.
      const needed = preset.positionSizeSol * preset.maxPositions;
      if (needed > val.global.paper.capitalPerPresetSol) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["presets", id, "positionSizeSol"],
          message:
            `${preset.maxPositions} Positionen à ${preset.positionSizeSol} SOL brauchen ` +
            `${round2(needed)} SOL, aber paper.capitalPerPresetSol ist ` +
            `${val.global.paper.capitalPerPresetSol}`,
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Ungültige Konfiguration:\n- ${issues.join("\n- ")}`);
    this.name = "ConfigValidationError";
  }
}
