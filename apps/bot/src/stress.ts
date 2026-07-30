import {
  closePaperPosition,
  openPaperPosition,
  poolFeeRatePctPerDay,
  positionSizeSol,
  tickPaperPosition,
  type BotConfig,
  type GlobalConfig,
  type MarketTick,
  type PresetConfig,
} from "@lping/core";

/**
 * Stresstest der Presets gegen **synthetische** Marktpfade (KONZEPT-ML.md M3).
 *
 * Ergänzung zum Replay, keine Konkurrenz — die beiden beantworten verschiedene
 * Fragen. Der Replay sagt, was auf den aufgezeichneten Verläufen passiert
 * **wäre**. Er kann aber nicht sagen, *warum*: Volatilität und Umschlag sind
 * dort miteinander verwoben, wie der Markt sie geliefert hat.
 *
 * Hier sind sie getrennt einstellbar. Das beantwortet die Frage, an der die
 * Auslegung der Presets hängt: **Bei welcher Volatilität und welchem Umschlag
 * trägt diese Bauform überhaupt?** Und es macht sichtbar, wie stark ein Ergebnis
 * an den Modellannahmen hängt statt am Markt — `poolLiquidityBins` allein
 * skaliert die gesamte Ertragsseite linear.
 *
 * Deterministisch über einen eigenen RNG mit festem Seed: Zwei Läufe mit
 * denselben Parametern liefern dasselbe Ergebnis, sonst wäre kein Vergleich
 * reproduzierbar.
 */

export interface StressScenario {
  label: string;
  tvlUsd: number;
  /** Handelsvolumen als Vielfaches des TVL pro Tag. */
  volTvl: number;
  /** Gesamte Swap-Gebühr des Pools in %. */
  feePct: number;
  /** Realisierte Tagesvolatilität in %. */
  sigmaPctDaily: number;
  /** Erwartete Preisänderung pro Tag in % (Memecoins: negativ). */
  driftPctDaily: number;
  binStep: number;
  solPriceUsd: number;
  /** Abstand zwischen zwei Beobachtungen in Minuten. */
  tickMinutes: number;
}

export const DEFAULT_SCENARIO: StressScenario = {
  label: "Standard",
  tvlUsd: 150_000,
  volTvl: 6,
  feePct: 0.6,
  sigmaPctDaily: 80,
  driftPctDaily: -5,
  binStep: 50,
  solPriceUsd: 150,
  tickMinutes: 15,
};

/** Reproduzierbarer RNG — keine Wanduhr, kein `Math.random`. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rnd: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface StressRun {
  pnlPct: number;
  feesPct: number;
  costsPct: number;
  vsHodlPct: number;
  timeInRangePct: number;
  hours: number;
  closeReason: string;
  win: boolean;
}

const EPOCH = new Date("2026-01-01T00:00:00Z");

/** Ein Positionsleben auf einem geometrischen Zufallspfad. */
export function stressOnce(
  preset: PresetConfig,
  global: GlobalConfig,
  scenario: StressScenario,
  rnd: () => number,
): StressRun {
  const depositSol = positionSizeSol(preset);
  const volume24hUsd = scenario.tvlUsd * scenario.volTvl;
  const feeRate = poolFeeRatePctPerDay(volume24hUsd, scenario.feePct, scenario.tvlUsd);

  let price = 0.000001;
  let state = openPaperPosition({
    preset,
    global,
    binStep: scenario.binStep,
    price,
    depositSol,
    feePct: scenario.feePct,
    feeRatePctPerDay: feeRate,
    // Das Szenario kennt seine Volatilität exakt — genau der Fall, für den die
    // Range-Herleitung gebaut ist.
    volatilityPctDaily: scenario.sigmaPctDaily,
    at: EPOCH,
  });

  const dtDays = scenario.tickMinutes / 1440;
  const sigma = scenario.sigmaPctDaily / 100;
  const mu = scenario.driftPctDaily / 100;
  const maxTicks = Math.ceil((preset.maxHoldHours * 60) / scenario.tickMinutes) + 2;

  let closeReason = "end_of_horizon";
  for (let i = 1; i <= maxTicks; i++) {
    price *= Math.exp((mu - (sigma * sigma) / 2) * dtDays + sigma * Math.sqrt(dtDays) * gaussian(rnd));
    const tick: MarketTick = {
      priceInSol: price,
      poolTvlUsd: scenario.tvlUsd,
      poolVolume24hUsd: volume24hUsd,
      poolVolume24hUsdSlow: volume24hUsd,
      poolFeePct: scenario.feePct,
      protocolFeePct: 10,
      solPriceUsd: scenario.solPriceUsd,
      at: new Date(EPOCH.getTime() + i * scenario.tickMinutes * 60_000),
    };
    const result = tickPaperPosition(state, tick, preset, global);
    state = result.state;
    if (result.closeReason !== null) {
      closeReason = result.closeReason;
      break;
    }
  }

  const closed = closePaperPosition(state, price, global);
  return {
    pnlPct: closed.valuation.pnlPct,
    feesPct: ((closed.state.feesClaimedSol + closed.state.feesUnclaimedSol) / depositSol) * 100,
    costsPct: (closed.state.costsSol / depositSol) * 100,
    vsHodlPct: (closed.valuation.vsHodlSol / depositSol) * 100,
    timeInRangePct: closed.valuation.timeInRangePct,
    hours: closed.state.msTotal / 3_600_000,
    closeReason,
    win: closed.valuation.pnlSol > 0,
  };
}

export interface StressSummary {
  runs: number;
  medianPnlPct: number;
  meanPnlPct: number;
  p10PnlPct: number;
  p90PnlPct: number;
  feesPct: number;
  costsPct: number;
  vsHodlPct: number;
  timeInRangePct: number;
  meanHours: number;
  winRatePct: number;
  closeReasons: Record<string, number>;
}

export function stressBatch(
  preset: PresetConfig,
  global: GlobalConfig,
  scenario: StressScenario,
  runs: number,
  seed = 20260101,
): StressSummary {
  const rnd = mulberry32(seed);
  const rows = Array.from({ length: runs }, () => stressOnce(preset, global, scenario, rnd));
  const pnl = rows.map((r) => r.pnlPct).sort((a, b) => a - b);
  const at = (q: number): number => pnl[Math.min(pnl.length - 1, Math.floor(q * pnl.length))]!;
  const mean = (get: (r: StressRun) => number): number =>
    rows.reduce((sum, r) => sum + get(r), 0) / rows.length;

  const closeReasons: Record<string, number> = {};
  for (const row of rows) closeReasons[row.closeReason] = (closeReasons[row.closeReason] ?? 0) + 1;

  return {
    runs,
    medianPnlPct: at(0.5),
    meanPnlPct: mean((r) => r.pnlPct),
    p10PnlPct: at(0.1),
    p90PnlPct: at(0.9),
    feesPct: mean((r) => r.feesPct),
    costsPct: mean((r) => r.costsPct),
    vsHodlPct: mean((r) => r.vsHodlPct),
    timeInRangePct: mean((r) => r.timeInRangePct),
    meanHours: mean((r) => r.hours),
    winRatePct: (rows.filter((r) => r.win).length / rows.length) * 100,
    closeReasons,
  };
}

/**
 * Eine Achse der Sensitivitätsanalyse: ein Parameter variiert, alles andere
 * fest. Der Kern von M3 — und der Grund, warum die Modellannahmen hier
 * gleichberechtigt neben den Strategieparametern stehen.
 */
export interface Sweep {
  label: string;
  values: (string | number)[];
  run: (value: string | number) => StressSummary;
}

export function modelAssumptionSweeps(
  preset: PresetConfig,
  global: GlobalConfig,
  scenario: StressScenario,
  runs: number,
): Sweep[] {
  const withPaper = (patch: Partial<GlobalConfig["paper"]>): GlobalConfig => ({
    ...global,
    paper: { ...global.paper, ...patch },
  });

  return [
    {
      label: "poolLiquidityBins (Fremdliquidität im aktiven Bin)",
      values: [10, 20, 30, 70, 140],
      run: (value) =>
        stressBatch(preset, withPaper({ poolLiquidityBins: Number(value) }), scenario, runs),
    },
    {
      label: "feeShareHaircutPct (Sicherheitsabschlag)",
      values: [0, 15, 30, 50],
      run: (value) =>
        stressBatch(preset, withPaper({ feeShareHaircutPct: Number(value) }), scenario, runs),
    },
    {
      label: "costs.swapSlippagePct (größter variabler Kostenposten)",
      values: [0.1, 0.5, 1, 2],
      run: (value) =>
        stressBatch(
          preset,
          withPaper({ costs: { ...global.paper.costs, swapSlippagePct: Number(value) } }),
          scenario,
          runs,
        ),
    },
    {
      label: "tickMinutes (Abtastraster der Aufzeichnung)",
      values: [1, 5, 15, 60],
      run: (value) =>
        stressBatch(preset, global, { ...scenario, tickMinutes: Number(value) }, runs),
    },
  ];
}

/**
 * Die Strategie-Stellschrauben, die nach den Modellannahmen am meisten bewegen.
 *
 * `coverageSigmas` steht bewusst vorn: Es ist der Regler des LP-Dilemmas. Eng
 * bedeutet hohen Gebührenanteil und wenig Zeit in Range, weit das Gegenteil.
 * Beides ist einzeln falsch, und das Optimum hängt an der Volatilität — genau
 * deshalb wird es gemessen und nicht gesetzt.
 */
export function strategySweeps(
  preset: PresetConfig,
  global: GlobalConfig,
  scenario: StressScenario,
  runs: number,
): Sweep[] {
  return [
    {
      label: "binRange.coverageSigmas (Range-Breite je σ)",
      values: [0.3, 0.6, 1, 1.5, 2.5, 4],
      run: (value) =>
        stressBatch(
          { ...preset, binRange: { ...preset.binRange, coverageSigmas: Number(value) } },
          global,
          scenario,
          runs,
        ),
    },
    {
      label: "stopLossPct (Rückfalllinie)",
      values: [15, 25, 35, 50],
      run: (value) => stressBatch({ ...preset, stopLossPct: Number(value) }, global, scenario, runs),
    },
    {
      label: "exit.feeStallHours (Geduld mit totem Kapital)",
      values: [1, 3, 6, 12, 48],
      run: (value) =>
        stressBatch(
          { ...preset, exit: { ...preset.exit, feeStallHours: Number(value) } },
          global,
          scenario,
          runs,
        ),
    },
  ];
}

export function marketSweeps(
  preset: PresetConfig,
  global: GlobalConfig,
  scenario: StressScenario,
  runs: number,
): Sweep[] {
  return [
    {
      label: "Volatilität σ (%/Tag)",
      values: [20, 40, 80, 150],
      run: (value) =>
        stressBatch(preset, global, { ...scenario, sigmaPctDaily: Number(value) }, runs),
    },
    {
      label: "Umschlag Vol/TVL (×/Tag)",
      values: [2, 6, 15, 30, 60],
      run: (value) => stressBatch(preset, global, { ...scenario, volTvl: Number(value) }, runs),
    },
    {
      label: "Drift (%/Tag)",
      values: [10, 0, -10, -30],
      run: (value) =>
        stressBatch(preset, global, { ...scenario, driftPctDaily: Number(value) }, runs),
    },
  ];
}

/**
 * Regime-Landkarte: Bei welcher Kombination aus Volatilität und Umschlag trägt
 * die Bauform?
 *
 * Die vielleicht wichtigste einzelne Ausgabe — sie zeigt, ob die Auswahlfilter
 * überhaupt in die Richtung zeigen, in der das Ergebnis positiv wird.
 */
export function regimeGrid(
  preset: PresetConfig,
  global: GlobalConfig,
  scenario: StressScenario,
  runs: number,
): { sigma: number; volTvl: number; summary: StressSummary }[] {
  const out: { sigma: number; volTvl: number; summary: StressSummary }[] = [];
  for (const sigma of [20, 40, 80, 150]) {
    for (const volTvl of [3, 6, 15, 30]) {
      out.push({
        sigma,
        volTvl,
        summary: stressBatch(
          preset,
          global,
          { ...scenario, sigmaPctDaily: sigma, volTvl, driftPctDaily: 0 },
          runs,
        ),
      });
    }
  }
  return out;
}

/** Szenario, das zum Preset passt — Startpunkt, den Optionen überschreiben. */
export function scenarioForPreset(config: BotConfig, presetId: string): StressScenario {
  const preset = config.presets[presetId];
  if (preset === undefined) return DEFAULT_SCENARIO;

  // Mitte des zulässigen Volatilitäts- und Umschlagbands: Was das Preset
  // ausdrücklich sucht, ist der ehrliche Ausgangspunkt für seinen Stresstest.
  const vol = preset.volatilityBoundsPctDaily;
  const volTvl = preset.volTvlBounds;
  const sigma = (vol.min + vol.max) / 2;

  // Der Bin Step folgt der Volatilität, nicht dem Preset-Minimum. Meteora
  // konfiguriert volatile Paare mit 100–400 bps und ruhige mit 1–25 — ein
  // σ-40-%-Token in einem 20-bps-Pool ist kein typischer Fall, sondern der
  // ungünstigste innerhalb des Zulässigen. Ihn als Standard zu nehmen hieße,
  // die Presets gegen ein Szenario zu prüfen, das sie so kaum antreffen.
  const binStep = Math.min(400, Math.max(preset.discovery.minBinStep, Math.round(sigma)));

  return {
    ...DEFAULT_SCENARIO,
    label: preset.label,
    tvlUsd: Math.max(preset.minTvlUsd, 50_000),
    volTvl: (volTvl.min + Math.min(volTvl.max, 30)) / 2,
    feePct: Math.max(preset.discovery.minBaseFeePct * 1.5, 0.3),
    sigmaPctDaily: sigma,
    binStep,
  };
}
