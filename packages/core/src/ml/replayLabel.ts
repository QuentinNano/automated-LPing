import type { GlobalConfig, PresetConfig } from "../config/schema";
import { replayPosition, type ReplayPool } from "../replay/engine";
import { OUTCOME_HORIZONS_HOURS, type TrackPoint } from "./outcomes";

/**
 * Ergebnis-Labels aus der **Simulation** statt aus einer Pool-Kennzahl
 * (KONZEPT-ML.md 6.3).
 *
 * **Warum es diese Datei gibt.** `computeOutcomes` liefert unter anderem
 * `feeYieldPct`: die laufende Rate `Gebühren / TVL`, über den Horizont
 * integriert. Das ist der Ertrag **eines Pools** — ohne Range, ohne Zeit
 * außerhalb, ohne Impermanent Loss, ohne Kosten, ohne Limit-Order-Abzweig. Ein
 * Auswahlmodell, das darauf trainiert, lernt „welcher Pool hat viel Umschlag",
 * nicht „welcher Pool trägt eine Position".
 *
 * Genau diese Verwechslung hat das Projekt an anderer Stelle bereits
 * korrigiert: `volatilityBoundsPctDaily` und der `yield_per_variance`-Term im
 * Score existieren, weil eine hohe Fee/TVL-Rate eben **nicht** automatisch
 * einen guten Kandidaten macht — Gebühren wachsen linear mit dem Umschlag, der
 * Varianzverlust quadratisch mit der Volatilität. Ein Label, das den
 * Varianzverlust nicht kennt, kann diesen Unterschied nicht lehren.
 *
 * Seit M2 gibt es die Komponente, die die richtige Frage beantwortet. Dieses
 * Modul schickt den aufgezeichneten Verlauf durch **dieselbe** Engine, die auch
 * handelt, und nimmt als Label heraus, was am Ende übrig blieb.
 *
 * `feeYieldPct` bleibt daneben stehen. Es ist billig, es braucht keine
 * Pool-Stammdaten, und es beantwortet eine andere, ebenfalls sinnvolle Frage
 * („wie ertragsstark war der Pool?"). Das eine ersetzt das andere nicht.
 */

/**
 * Version der Label-Berechnung. Bei jeder Änderung an der Referenzposition
 * oder an der Bedeutung der Felder erhöhen.
 *
 * Labels verschiedener Versionen dürfen nicht vermischt werden — sie messen
 * dann verschiedene Dinge unter demselben Namen. Dasselbe gilt für die
 * Modellannahmen in `global.paper`: Wer `poolLiquidityBins` oder einen der
 * Abschläge ändert, ändert jedes Label. Der README beschreibt den Weg dafür,
 * und er gilt unverändert — `candidate_outcomes` ist die ersetzbare Tabelle.
 */
export const LABEL_VERSION = 1;

/**
 * Die **Standardposition**, an der Kandidaten gemessen werden.
 *
 * Bewusst eine Konstante im Code und kein Preset aus der Konfiguration. Ein
 * Label muss über die Zeit dasselbe bedeuten; hinge es an einer editierbaren
 * Datei, verschöbe jede Parameteränderung rückwirkend die Zielgröße, und der
 * Datensatz wäre in sich widersprüchlich, ohne dass es jemand bemerkt.
 *
 * **Feste Bin-Zahl statt hergeleiteter Breite.** Die Presets leiten ihre Range
 * aus der Volatilität her, und das ist für den Handel richtig. Für ein Label
 * wäre es falsch: Die Zielgröße hinge dann an einer Schätzung, die selbst
 * verrauscht ist, und zwei Pools wären nicht mehr vergleichbar, weil sie mit
 * verschiedener Geometrie gemessen wurden. Ein Label beantwortet „was hätte
 * eine **Standardposition** hier verdient?", und Standard heißt fest.
 *
 * Die 69 Bins sind die DLMM-Standardbreite; die Strategie ist Spot, weil sie
 * als einzige keine Annahme über die Richtung der Bewegung macht. Zweiseitig,
 * damit die Position vom ersten Tick an verdient und das Label nicht davon
 * abhängt, ob der Markt eine Kauforder zufällig erreicht hat.
 *
 * Die Ausstiegsregeln stehen an ihren Extremwerten: Das Label soll den Verlauf
 * über den **ganzen** Horizont messen, nicht den Zeitpunkt, an dem eine
 * bestimmte Regel gegriffen hätte. Welche Ausstiegsregel gut ist, gehört zur
 * Optimierung — nicht in die Zielgröße, gegen die optimiert wird.
 */
export const REFERENCE_POSITION: PresetConfig = {
  label: "Referenz",
  enabled: false,
  capitalSharePct: 0,
  positionSizeSol: 1,
  maxPositions: 1,
  minScore: 0,
  minTvlUsd: 0,
  tokenAgeHours: { min: 0 },
  volTvlBounds: { min: 0, max: 1_000 },
  volatilityBoundsPctDaily: { min: 0, max: 1_000 },
  screening: {
    maxTop10HolderPct: 100,
    maxSingleHolderPct: 100,
    maxInsiderPct: 100,
    minHolders: 0,
    maxPriceDivergencePct: 20,
    maxPoolShareOfTvlPct: 20,
    maxSingleLpDominancePct: 100,
    maxNormalizedRiskScore: 100,
    maxAvgTradeUsd: 1_000_000,
  },
  discovery: { minBinStep: 1, minBaseFeePct: 0 },
  strategy: { type: "Spot", sided: "balanced" },
  // Ohne `coverageSigmas`: `min === max` heißt, dass `deriveBinWidth` genau
  // diesen Wert liefert, unabhängig von jeder Volatilitätsschätzung.
  binRange: { min: 69, max: 69 },
  feeHarvest: {
    claimIntervalMin: 60,
    convertToSolPct: 100,
    minClaimValueSol: 0,
    claimCostFactor: 1,
    dustThresholdSol: 0,
  },
  compound: { enabled: false, minSol: 0 },
  stopLossPct: 90,
  maxHoldHours: 1,
  rebalance: {
    enabled: false,
    bufferPct: 10,
    cooldownMin: 0,
    maxPerDay: 0,
    minEvFactor: 1,
    projectionHours: 12,
  },
  slippageCapPct: 10,
  exit: {
    priceCrashPct: 95,
    priceWindowMin: 5,
    tvlDrainPct: 95,
    tvlWindowMin: 5,
    feeCollapsePct: 99,
    feeStallHours: 24 * 14,
    feeStallMinPctPerDay: 0,
  },
  emergency: { priceDropPct5m: 95, tvlDropPct10m: 95, sellImpactMaxPct: 95 },
};

export interface ReplayOutcomeLabel {
  horizonHours: number;
  /**
   * Netto-Ertrag der Standardposition in % des Einsatzes — nach Gebühren,
   * Impermanent Loss und allen simulierten On-Chain-Kosten.
   */
  replayPnlPct: number | null;
  /**
   * Derselbe Ertrag gegenüber schlichtem Halten, in % des Einsatzes.
   *
   * Die eigentliche Frage an eine LP-Position: Ein Pool, in dem eine Position
   * 3 % verdient, während Halten 8 % gebracht hätte, ist kein guter Kandidat.
   * KONZEPT-ML.md 6.4 führt das als Nebenbedingung der Zielfunktion — als Label
   * ist es direkt lernbar.
   */
  replayVsHodlPct: number | null;
  /**
   * Wurde die Position vom Ende der Daten abgeschnitten statt vom Horizont?
   *
   * Rechtszensierte Labels sind nicht falsch, aber sie messen einen kürzeren
   * Zeitraum als sie behaupten. Wer sie wie vollständige zählt, bevorzugt
   * systematisch Kandidaten, deren Aufzeichnung früh abriss.
   */
  censored: boolean;
}

/**
 * Spielt die Standardposition über jeden Horizont ab.
 *
 * `points` muss nach Zeit aufsteigend sortiert sein und bei `decisionAt`
 * beginnen — dieselbe Zeitreihe, die `computeOutcomes` sieht.
 *
 * Ein Horizont ohne verwertbaren Tick bekommt ein leeres Label statt gar
 * keines: „hier ließ sich nichts simulieren" ist ein Ergebnis, und nur so
 * verlässt der Kandidat den Stapel der Nachberechnung.
 */
export function computeReplayOutcomes(
  decisionAt: Date,
  points: TrackPoint[],
  pool: ReplayPool,
  global: GlobalConfig,
  horizons: readonly number[] = OUTCOME_HORIZONS_HOURS,
): ReplayOutcomeLabel[] {
  const startMs = decisionAt.getTime();
  const inOrder = points
    .filter((point) => point.ts.getTime() >= startMs)
    .sort((a, b) => a.ts.getTime() - b.ts.getTime());

  return horizons.map((horizonHours) => {
    const endMs = startMs + horizonHours * 3_600_000;
    const window = inOrder.filter((point) => point.ts.getTime() <= endMs);
    if (window.length < 2) return empty(horizonHours);

    const replayed = replayPosition(window, pool, {
      // Die Haltedauer ist der Horizont: Das Label misst genau diesen Zeitraum.
      preset: { ...REFERENCE_POSITION, maxHoldHours: horizonHours },
      global,
    });
    if (replayed === null) return empty(horizonHours);

    return {
      horizonHours,
      replayPnlPct: finite(replayed.valuation.pnlPct),
      replayVsHodlPct: finite(
        replayed.state.depositSol > 0
          ? (replayed.valuation.vsHodlSol / replayed.state.depositSol) * 100
          : null,
      ),
      censored: replayed.censored,
    };
  });
}

function empty(horizonHours: number): ReplayOutcomeLabel {
  return { horizonHours, replayPnlPct: null, replayVsHodlPct: null, censored: false };
}

function finite(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? value : null;
}
