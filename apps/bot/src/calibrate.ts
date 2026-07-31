import {
  calibrate,
  crossFitPoolLiquidityBins,
  fitPoolLiquidityBins,
  type BotConfig,
  type CrossFitResult,
  type CalibrationInput,
  type CalibrationResult,
  type PoolCandle,
  type PoolMetrics,
  type PresetConfig,
  type RealPosition,
  type TrackPoint,
} from "@lping/core";
import type { MeteoraAdapter } from "@lping/adapters";

/**
 * Kalibrierung gegen echte Positionen (`pnpm --filter @lping/bot calibrate`).
 *
 * Der Ablauf ist bewusst kurz und braucht **keine Datenbank**: Portfolio eines
 * Wallets holen, geschlossene Positionen je Pool holen, für jede die Historie
 * ihres Zeitraums nachladen und die Zeitspanne durch die eigene Engine
 * schicken. Was herauskommt, ist ein Faktor — gemessene Gebühren geteilt durch
 * modellierte.
 *
 * **Warum ein fremdes Wallet reicht.** Die Positions-Endpunkte sind öffentlich;
 * es braucht weder eigenes Kapital noch einen Schlüssel. Jedes Wallet, das auf
 * Meteora Liquidität stellt, ist eine Messreihe. Der Datensatz ist damit sofort
 * verfügbar, während eigene Positionen erst Kalenderzeit kosten würden.
 */

export interface CalibrateDeps {
  meteora: Pick<MeteoraAdapter, "getPortfolio" | "getPositions" | "getHistory" | "getPair">;
  log?: (line: string) => void;
}

export interface CalibrateOptions {
  wallet: string;
  /** Nur diesen Pool prüfen; sonst alle aus dem Portfolio. */
  pool?: string;
  /** Obergrenze der geprüften Positionen — jede kostet einen Historien-Abruf. */
  maxPositions?: number;
  /** Preset, dessen Kosten- und Gebührenannahmen geprüft werden. */
  presetId?: string;
}

const DEFAULT_MAX_POSITIONS = 25;

export interface CalibrateReport {
  wallet: string;
  preset: string;
  result: CalibrationResult;
  fitted: { poolLiquidityBins: number; medianFactor: number } | null;
  /**
   * Derselbe Fit, aber kreuzgeprüft: auf der einen Hälfte der Pools gesucht,
   * auf der anderen gemessen. `null`, wenn es weniger als zwei Pools gibt.
   */
  crossFit: CrossFitResult | null;
  /** `poolLiquidityBins`, mit dem gerechnet wurde. */
  configured: number;
  positionsSeen: number;
}

export async function runCalibration(
  deps: CalibrateDeps,
  config: BotConfig,
  options: CalibrateOptions,
): Promise<CalibrateReport> {
  const log = deps.log ?? (() => {});
  const presetId = options.presetId ?? firstEnabledPreset(config);
  const preset = config.presets[presetId];
  if (preset === undefined) {
    throw new Error(`Preset "${presetId}" existiert nicht`);
  }

  const pools =
    options.pool !== undefined
      ? [options.pool]
      : (await deps.meteora.getPortfolio(options.wallet, { status: "closed" })).map(
          (entry) => entry.poolAddress,
        );
  log(`${pools.length} Pool(s) mit geschlossenen Positionen`);

  const maxPositions = options.maxPositions ?? DEFAULT_MAX_POSITIONS;
  const positions: RealPosition[] = [];
  for (const poolAddress of pools) {
    if (positions.length >= maxPositions) break;
    const found = await deps.meteora.getPositions(poolAddress, options.wallet, {
      status: "closed",
    });
    positions.push(...found.slice(0, maxPositions - positions.length));
  }
  log(`${positions.length} geschlossene Position(en) gefunden`);

  const inputs: CalibrationInput[] = [];
  const poolCache = new Map<string, PoolMetrics | null>();
  for (const position of positions) {
    if (position.openedAt === null) continue;

    let pool = poolCache.get(position.poolAddress);
    if (pool === undefined) {
      pool = await deps.meteora.getPair(position.poolAddress).catch(() => null);
      poolCache.set(position.poolAddress, pool);
    }
    if (pool === null) continue;

    // Der Zeitraum wird großzügig geholt: Der Replay beschneidet ihn selbst auf
    // die Lebensdauer der Position, und eine Kerze zu wenig kostet den Fall.
    const until = position.closedAt ?? new Date();
    const candles = await deps.meteora
      .getHistory(position.poolAddress, {
        timeframe: "5m",
        startTime: new Date(position.openedAt.getTime() - 10 * 60_000),
        endTime: new Date(until.getTime() + 10 * 60_000),
      })
      .catch(() => [] as PoolCandle[]);
    if (candles.length === 0) continue;

    inputs.push({
      position,
      series: seriesFromCandles(candles, pool),
      pool: {
        poolAddress: position.poolAddress,
        mintX: pool.mintX,
        mintY: pool.mintY,
        binStep: pool.binStep,
        ...(pool.collectFeeMode !== undefined ? { collectFeeMode: pool.collectFeeMode } : {}),
        rewardMints: pool.rewardMints,
        ...(pool.hasFarm !== undefined ? { hasFarm: pool.hasFarm } : {}),
      },
    });
  }

  const result = calibrate(inputs, { preset, global: config.global });
  const fitted = fitPoolLiquidityBins(inputs, { preset, global: config.global });
  const crossFit = crossFitPoolLiquidityBins(inputs, { preset, global: config.global });

  return {
    wallet: options.wallet,
    preset: presetId,
    result,
    fitted,
    crossFit,
    configured: config.global.paper.poolLiquidityBins,
    positionsSeen: positions.length,
  };
}

/**
 * Kerzen in die Beobachtungsform, mit der die Engine rechnet.
 *
 * Der TVL fehlt der Historie — er existiert nur als Momentaufnahme. Für die
 * Kalibrierung wird der **heutige** TVL des Pools über den ganzen Zeitraum
 * getragen, und das ist die schwächste Stelle des Verfahrens: Ein Pool, dessen
 * Liquidität sich seither halbiert hat, verschiebt den gemessenen Faktor um
 * denselben Betrag. Deshalb gehören kurze, junge Zeiträume bevorzugt — und
 * deshalb ist der Median über viele Positionen belastbarer als jeder Einzelfall.
 */
function seriesFromCandles(candles: PoolCandle[], pool: PoolMetrics): TrackPoint[] {
  const tvlUsd = pool.tvlUsd ?? null;
  const solPriceUsd = solPriceOf(pool);

  return candles.map((candle) => ({
    ts: candle.ts,
    priceNative: candle.close ?? candle.open,
    high: candle.high,
    low: candle.low,
    tvlUsd,
    solPriceUsd,
    volume24hUsd: candle.volumeUsd === null ? null : candle.volumeUsd * 288,
    fees24hUsd: candle.feesUsd === null ? null : candle.feesUsd * 288,
    protocolFeePct:
      candle.feesUsd !== null && candle.feesUsd > 0 && candle.protocolFeesUsd !== null
        ? (candle.protocolFeesUsd / candle.feesUsd) * 100
        : null,
    dynamicFeePct: null,
    baseFeePct: pool.baseFeePct ?? null,
    windows: null,
  }));
}

function solPriceOf(pool: PoolMetrics): number | null {
  const price = pool.tokenY?.priceUsd ?? pool.tokenX?.priceUsd ?? null;
  return price !== null && Number.isFinite(price) && price > 0 ? price : null;
}

function firstEnabledPreset(config: BotConfig): string {
  const entry = Object.entries(config.presets).find(([, preset]) => preset.enabled);
  return entry?.[0] ?? Object.keys(config.presets)[0] ?? "balanced";
}

/**
 * Bericht als Text.
 *
 * Der wichtigste Wert steht am Ende und ist ein Urteil, keine Zahl zum
 * Selbstdeuten: Rechnet die Simulation zu großzügig oder zu streng, und um
 * welchen Faktor?
 */
export function formatCalibration(report: CalibrateReport, preset: PresetConfig): string {
  const lines: string[] = [];
  const { result } = report;

  lines.push(
    `Kalibrierung gegen echte Positionen — Wallet ${report.wallet.slice(0, 8)}…, ` +
      `Preset ${preset.label}`,
  );
  lines.push("");

  if (result.cases.length === 0) {
    lines.push(`Kein vergleichbarer Fall aus ${report.positionsSeen} Position(en).`);
    lines.push(...skippedLines(result));
    lines.push("");
    lines.push(
      "Ein leeres Ergebnis ist selbst eine Auskunft: Es sagt, welche Angabe die",
      "Schnittstelle nicht liefert. `pnpm --filter @lping/bot api:check` zeigt,",
      "was tatsächlich ankommt.",
    );
    return lines.join("\n");
  }

  lines.push(
    "Position    Stunden   Einsatz    Bins    gemessen   modelliert   Faktor",
  );
  for (const entry of result.cases) {
    lines.push(
      `${entry.positionAddress.slice(0, 8)}…  ` +
        `${entry.hours.toFixed(1).padStart(7)}  ` +
        `${entry.depositSol.toFixed(3).padStart(8)}  ` +
        `${String(entry.binWidth).padStart(6)}  ` +
        `${entry.measuredFeesSol.toFixed(5).padStart(10)}  ` +
        `${entry.modelledFeesSol.toFixed(5).padStart(11)}  ` +
        `${entry.factor.toFixed(2).padStart(6)}×`,
    );
  }
  lines.push(...skippedLines(result));
  lines.push("");

  const factor = result.medianFactor!;
  lines.push(`Median-Faktor über ${result.cases.length} Fälle: ${factor.toFixed(2)}×`);
  lines.push(
    factor > 1.15
      ? `  → Die Simulation rechnet den Gebührenertrag ${factor.toFixed(1)}-fach zu NIEDRIG. ` +
          `Sie unterschätzt die Strategie.`
      : factor < 0.87
        ? `  → Die Simulation rechnet den Gebührenertrag ${(1 / factor).toFixed(1)}-fach zu HOCH. ` +
            `Das ist die gefährliche Richtung: Jede Profitabilitätsaussage ist zu freundlich.`
        : `  → Modell und Messung liegen innerhalb von ±15 % beieinander.`,
  );

  if (report.fitted !== null) {
    lines.push("");
    lines.push(
      `Bester poolLiquidityBins: ${report.fitted.poolLiquidityBins} ` +
        `(Restfaktor ${report.fitted.medianFactor.toFixed(2)}×), aktuell ${report.configured}`,
    );
    lines.push(
      "  Der Wert steht stellvertretend für drei Annahmen, die aus einer Messung",
      "  nicht zu trennen sind: Bin-Breite der übrigen LPs, Sicherheitsabschlag",
      "  und Limit-Order-Anteil. Er ist die Größe, mit der ihr Produkt korrigiert",
      "  wird — nicht die Behauptung, die anderen beiden seien richtig.",
    );
    lines.push(
      "",
      "  ACHTUNG bei späteren Messungen: Der Wert absorbiert die beiden anderen",
      "  Abschläge mit. Wer feeShareHaircutPct oder limitOrderShareHaircutPct",
      "  später einzeln misst, muss poolLiquidityBins neu fitten — sonst wird",
      "  derselbe Abschlag zweimal gezählt und der Ertrag doppelt gekürzt.",
    );
  }

  lines.push(...crossFitLines(report));

  return lines.join("\n");
}

/**
 * Der kreuzgeprüfte Fit — die Zahl, die zählt.
 *
 * Der Fit über alle Fälle liegt per Konstruktion nahe 1: Er wurde genau darauf
 * optimiert. Erst der Faktor auf der zurückgehaltenen Hälfte sagt, ob der Wert
 * etwas über den Markt weiß oder nur über die Stichprobe, aus der er stammt.
 */
function crossFitLines(report: CalibrateReport): string[] {
  const cross = report.crossFit;
  if (cross === null) {
    if (report.fitted === null) return [];
    return [
      "",
      "Keine Kreuzprüfung möglich: Dafür braucht es Positionen aus mindestens",
      "zwei Pools. Der Fit oben ist damit auf denselben Daten gemessen, auf denen",
      "er gesucht wurde — er ist eine Anpassung, keine Messung.",
    ];
  }

  const lines: string[] = ["", "Kreuzprüfung (gefittet auf einer Pool-Hälfte, gemessen auf der anderen):"];
  for (const fold of cross.folds) {
    lines.push(
      `  ${String(fold.trainPools).padStart(2)} Pools / ${String(fold.trainCases).padStart(3)} Fälle → ` +
        `poolLiquidityBins ${String(fold.poolLiquidityBins).padStart(3)}, ` +
        `Training ${fold.trainFactor.toFixed(2)}×, ` +
        `Holdout ${fold.holdoutFactor === null ? "–" : `${fold.holdoutFactor.toFixed(2)}×`} ` +
        `(${fold.holdoutPools} Pools / ${fold.holdoutCases} Fälle)`,
    );
  }

  if (cross.holdoutMedianFactor !== null) {
    const factor = cross.holdoutMedianFactor;
    lines.push(
      "",
      `  Holdout-Median: ${factor.toFixed(2)}× — das ist die belastbare Zahl.`,
    );
    if (Math.abs(Math.log(factor)) > Math.log(1.5)) {
      lines.push(
        "  Sie weicht deutlich von 1 ab: Der Fit überträgt sich nicht auf Pools,",
        "  die er nicht gesehen hat. Der gefundene Wert gehört dann NICHT in die",
        "  Konfiguration — er beschreibt die Stichprobe, nicht den Markt.",
      );
    }
  }

  if (cross.spread !== null && cross.spread > 2) {
    lines.push(
      "",
      `  ⚠ Die beiden Hälften kommen auf Werte, die um Faktor ${cross.spread.toFixed(1)}`,
      "    auseinanderliegen. Damit hängt das Ergebnis daran, welche Positionen",
      "    zufällig in welche Hälfte fielen — mehr Pools messen, bevor der Wert",
      "    irgendetwas begründet.",
    );
  }

  return lines;
}

function skippedLines(result: CalibrationResult): string[] {
  if (result.skipped.length === 0) return [];
  const counts = new Map<string, number>();
  for (const entry of result.skipped) {
    counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  }
  return [
    "",
    `Übersprungen: ${result.skipped.length}`,
    ...[...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `  ${String(count).padStart(3)}× ${reason}`),
  ];
}
