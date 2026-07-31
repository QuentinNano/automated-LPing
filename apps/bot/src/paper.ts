import {
  closePaperPosition,
  deployedCapitalSol,
  marketTickFromPool,
  openPaperPosition,
  poolFeePct,
  poolFeeRatePctPerDay,
  poolPriceInSol,
  positionSizeSol,
  solPriceUsdOf,
  tickPaperPosition,
  valuePosition,
  volumeRate24hUsd,
  type BotConfig,
  type PaperCloseReason,
  type PaperPositionState,
  type PoolMetrics,
  type PresetKind,
  type PresetPerformance,
} from "@lping/core";
import type { ScanRow } from "./scan";

/**
 * Multi-Preset-Paper-Trading (KONZEPT.md Abschnitt 13, Phase 1).
 *
 * Alle aktiven Presets laufen gleichzeitig auf **denselben** Marktdaten und
 * demselben Startkapital. Dadurch unterscheiden sich die Ergebnisse
 * ausschließlich in den Parametern — ein kontrolliertes Experiment statt
 * eines Vergleichs von Äpfeln mit Birnen.
 */

export interface PaperStore {
  open(record: {
    poolAddress: string;
    preset: PresetKind;
    strategyType: string;
    sided: string;
    mintX: string;
    mintY: string;
    binStep: number;
    state: PaperPositionState;
    openedAt: Date;
  }): Promise<string>;
  tick(record: {
    positionId: string;
    state: PaperPositionState;
    valuation: ReturnType<typeof valuePosition>;
  }): Promise<void>;
  close(record: {
    positionId: string;
    state: PaperPositionState;
    valuation: ReturnType<typeof valuePosition>;
    reason: PaperCloseReason;
    realizedPnlSol: number;
    closedAt: Date;
  }): Promise<void>;
  listOpen(preset?: PresetKind): Promise<
    { id: string; poolAddress: string; preset: string; simState: PaperPositionState }[]
  >;
  countOpen(preset: PresetKind): Promise<number>;
  hasOpenFor(preset: PresetKind, poolAddress: string): Promise<boolean>;
  performance(labels?: Record<string, string>): Promise<PresetPerformance[]>;
}

export interface PaperDeps {
  store: PaperStore;
  /** Aktuelle Pool-Metriken für offene Positionen nachladen. */
  getPool(poolAddress: string): Promise<PoolMetrics>;
  /** SOL-Preis in USD (für die Umrechnung von TVL/Volumen). */
  getSolPriceUsd(): Promise<number>;
  log?: (line: string) => void;
  now?: () => Date;
}

/**
 * Pool-TVL in SOL — Bezugsgröße des größenabhängigen Preisimpacts.
 *
 * Der SOL-Kurs kommt aus den Token-Angaben, die die Pool-API ohnehin
 * mitliefert. Fehlt eine der beiden Größen, bleibt es bei der Grundslippage:
 * Eine unbekannte Bezugsgröße wird nicht geschätzt.
 */
function poolTvlSolOf(pool: PoolMetrics): number | null {
  const solPriceUsd = solPriceUsdOf(pool);
  if (solPriceUsd === null || pool.tvlUsd === undefined || pool.tvlUsd <= 0) return null;
  return pool.tvlUsd / solPriceUsd;
}

export interface PaperCycleResult {
  opened: number;
  ticked: number;
  closed: number;
  notes: string[];
}

/**
 * Eröffnet neue Positionen für akzeptierte Scan-Kandidaten — je Preset
 * getrennt, mit eigenem virtuellem Kapital und eigenen Limits.
 */
export async function openFromScan(
  deps: PaperDeps,
  config: BotConfig,
  rows: ScanRow[],
): Promise<{ opened: number; notes: string[] }> {
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const notes: string[] = [];
  let opened = 0;

  const accepted = rows.filter((row) => row.screening.verdict === "accepted");
  for (const row of accepted) {
    const preset = config.presets[row.preset];
    if (preset === undefined || !preset.enabled) continue;

    const openCount = await deps.store.countOpen(row.preset);
    if (openCount >= preset.maxPositions) {
      notes.push(`${row.preset}: Positions-Limit erreicht (${openCount}/${preset.maxPositions})`);
      continue;
    }
    if (await deps.store.hasOpenFor(row.preset, row.pool.poolAddress)) continue;

    const price = poolPriceInSol(row.pool);
    if (price === null || price <= 0) {
      notes.push(`${row.preset}: kein Preis für ${row.pool.poolAddress.slice(0, 8)}…`);
      continue;
    }

    // Eine Quelle für die Positionsgröße, für Screening, Paper und Replay
    // dieselbe (ANALYSE.md 4.2).
    const depositSol = positionSizeSol(preset);
    const state = openPaperPosition({
      preset,
      global: config.global,
      binStep: row.pool.binStep,
      price,
      depositSol,
      feePct: poolFeePct(row.pool),
      feeRatePctPerDay: poolFeeRatePctPerDay(
        volumeRate24hUsd(row.pool),
        poolFeePct(row.pool),
        row.pool.tvlUsd ?? 0,
      ),
      // Steuert die Range-Breite: Sie folgt der Bewegung des Marktes, nicht
      // einer festen Bin-Zahl (ANALYSE.md 6, Punkt 6).
      volatilityPctDaily: row.volatilityPctDaily,
      // Bezugsgröße des Preisimpacts beim Einstiegs-Swap. Der SOL-Kurs steht
      // in den Token-Angaben des Pools — kein zusätzlicher Abruf nötig.
      poolTvlSol: poolTvlSolOf(row.pool),
      at: now,
    });

    await deps.store.open({
      poolAddress: row.pool.poolAddress,
      preset: row.preset,
      strategyType: preset.strategy.type,
      sided: preset.strategy.sided,
      mintX: row.pool.mintX,
      mintY: row.pool.mintY,
      binStep: row.pool.binStep,
      state,
      openedAt: now,
    });
    opened++;
    // Die Klemmung gehört ins Protokoll, nicht nur in den Zustand: Eine Range
    // an der Leitplanke ist nicht die Range, die die Volatilität verlangt, und
    // das ist beim Öffnen die einzige Gelegenheit, es zu bemerken.
    const clampNote =
      state.binWidthClamped === "max"
        ? ` ⚠ Breite an binRange.max geklemmt (nötig: ${state.binWidthDerived})`
        : state.binWidthClamped === "min"
          ? ` ⚠ Breite an binRange.min geklemmt (nötig: ${state.binWidthDerived})`
          : "";
    log(
      `+ ${row.preset}: ${row.pool.name ?? row.pool.poolAddress.slice(0, 10)} ` +
        `${depositSol.toFixed(3)} SOL, Bins ${state.minBinId}…${state.maxBinId}, Score ${row.screening.score.total}` +
        clampNote,
    );
  }

  return { opened, notes };
}

/** Aktualisiert alle offenen Positionen mit frischen Marktdaten. */
export async function tickOpenPositions(
  deps: PaperDeps,
  config: BotConfig,
): Promise<{ ticked: number; closed: number; notes: string[] }> {
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const notes: string[] = [];
  let ticked = 0;
  let closed = 0;

  const open = await deps.store.listOpen();
  if (open.length === 0) return { ticked, closed, notes };

  // Ohne SOL-Preis lassen sich TVL/Volumen nicht in SOL umrechnen — dann wird
  // dieser Durchgang übersprungen statt mit falschen Zahlen zu rechnen.
  let solPriceUsd: number;
  try {
    solPriceUsd = await deps.getSolPriceUsd();
  } catch (error) {
    notes.push(
      `SOL-Preis nicht abrufbar (${message(error)}) — Positionen bleiben unverändert.`,
    );
    return { ticked, closed, notes };
  }

  const poolCache = new Map<string, PoolMetrics | null>();

  for (const position of open) {
    const preset = config.presets[position.preset];
    if (preset === undefined) {
      notes.push(`Position ${position.id}: Preset "${position.preset}" existiert nicht mehr`);
      continue;
    }

    let pool = poolCache.get(position.poolAddress);
    if (pool === undefined) {
      try {
        pool = await deps.getPool(position.poolAddress);
      } catch (error) {
        pool = null;
        notes.push(
          `Pool ${position.poolAddress.slice(0, 8)}… nicht abrufbar: ${message(error)}`,
        );
      }
      poolCache.set(position.poolAddress, pool);
    }
    if (pool === null) continue;

    // Denselben Weg wie der Replay: Ein Tick entsteht an genau einer Stelle.
    const tick = marketTickFromPool(pool, { solPriceUsd, at: now });
    if (tick === null) continue;

    const result = tickPaperPosition(position.simState, tick, preset, config.global);
    ticked++;

    if (result.closeReason === null) {
      await deps.store.tick({
        positionId: position.id,
        state: result.state,
        valuation: result.valuation,
      });
      continue;
    }

    // Der Ausstiegs-Swap ist der größte im Leben einer Position — seine
    // Slippage hängt an ihrer Größe gegenüber dem Pool.
    const closeResult = closePaperPosition(result.state, tick.priceInSol, config.global, {
      preset,
      poolTvlSol: tick.solPriceUsd > 0 ? tick.poolTvlUsd / tick.solPriceUsd : null,
    });
    await deps.store.close({
      positionId: position.id,
      state: closeResult.state,
      valuation: closeResult.valuation,
      reason: result.closeReason,
      realizedPnlSol: closeResult.realizedPnlSol,
      closedAt: now,
    });
    closed++;
    log(
      `- ${position.preset}: ${position.poolAddress.slice(0, 10)}… geschlossen (${result.closeReason}), ` +
        `PnL ${closeResult.realizedPnlSol >= 0 ? "+" : ""}${closeResult.realizedPnlSol.toFixed(4)} SOL`,
    );
  }

  return { ticked, closed, notes };
}


export function presetLabels(config: BotConfig): Record<string, string> {
  return Object.fromEntries(Object.entries(config.presets).map(([id, p]) => [id, p.label]));
}

/**
 * Vergleichstabelle der Presets — das eigentliche Ergebnis von Phase 1.
 *
 * Sortiert nach **Rendite auf den Einsatz**, nicht nach absolutem PnL. Der
 * Unterschied ist kein Schönheitsfehler: Presets setzen verschieden viel Kapital
 * je Position ein, und wer nach absoluten SOL rankt, belohnt die größere
 * Position statt der besseren Strategie (ANALYSE.md 4.3). Der absolute PnL steht
 * weiter daneben — er beantwortet nur eine andere Frage.
 */
export function formatComparison(rows: PresetPerformance[]): string {
  if (rows.length === 0) return "Noch keine Paper-Positionen.";

  const header = [
    pad("Preset", 14),
    pad("offen", 6),
    pad("zu", 4),
    pad("Rendite%", 9),
    pad("PnL SOL", 10),
    pad("Einsatz", 9),
    pad("Fees", 9),
    pad("Kosten", 9),
    pad("Win%", 6),
    pad("inRange%", 9),
    "vs HODL",
  ].join(" ");
  const lines = [header, "-".repeat(header.length + 4)];

  const returnPct = (row: PresetPerformance): number | null =>
    row.depositedSol > 0 ? (row.totalPnlSol / row.depositedSol) * 100 : null;

  const sorted = [...rows].sort((a, b) => (returnPct(b) ?? -Infinity) - (returnPct(a) ?? -Infinity));
  for (const row of sorted) {
    const ret = returnPct(row);
    lines.push(
      [
        pad(row.label, 14),
        pad(String(row.openPositions), 6),
        pad(String(row.closedPositions), 4),
        pad(ret === null ? "–" : signed(ret, 2), 9),
        pad(signed(row.totalPnlSol, 4), 10),
        pad(row.depositedSol.toFixed(2), 9),
        pad(row.feesEarnedSol.toFixed(4), 9),
        pad(row.costsSol.toFixed(4), 9),
        pad(row.winRatePct === null ? "–" : row.winRatePct.toFixed(0), 6),
        pad(row.avgTimeInRangePct === null ? "–" : row.avgTimeInRangePct.toFixed(0), 9),
        signed(row.vsHodlSol, 4),
      ].join(" "),
    );
  }

  const decided = rows.reduce((sum, r) => sum + r.closedPositions, 0);
  if (decided < 20) {
    lines.push(
      "",
      `Hinweis: erst ${decided} geschlossene Positionen — zu wenig für belastbare Aussagen.`,
      "Statistisch tragfähig wird der Vergleich ab ca. 20–30 Positionen je Preset.",
    );
  }
  return lines.join("\n");
}

function pad(value: string, width: number): string {
  return value.length > width ? value.slice(0, width - 1) + "…" : value.padEnd(width);
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
