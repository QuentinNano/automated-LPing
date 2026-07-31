import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  ConfigService,
  parseBotConfig,
  type BotConfig,
  type PresetPerformance,
  type ScreeningResult,
} from "@lping/core";
import { PaperRepo, PrismaConfigStore, createPrisma, type PrismaClient } from "@lping/db";

/**
 * Datenzugriff der UI. Server-only: Prisma-Client und Dateisystem werden
 * ausschließlich in Server Components/Actions benutzt.
 */

const repoRoot = path.resolve(process.cwd(), "../..");
const configDir = path.join(repoRoot, "config");

let prismaSingleton: PrismaClient | null = null;

export function prisma(): PrismaClient {
  // In der Entwicklung würde Hot-Reload sonst pro Reload einen Client öffnen.
  prismaSingleton ??= createPrisma();
  return prismaSingleton;
}

/** Default-Konfiguration aus /config (Seed für Version 1). */
export function loadDefaults(): BotConfig {
  const files = readdirSync(configDir).filter((f) => f.endsWith(".json"));
  const read = (name: string) =>
    JSON.parse(readFileSync(path.join(configDir, name), "utf8")) as unknown;

  const presets: Record<string, unknown> = {};
  for (const file of files) {
    if (file === "global.json") continue;
    presets[path.basename(file, ".json")] = read(file);
  }
  return parseBotConfig({ global: read("global.json"), presets });
}

export async function configService(): Promise<ConfigService> {
  return ConfigService.init(new PrismaConfigStore(prisma()), loadDefaults());
}

export async function currentConfig(): Promise<BotConfig> {
  return (await configService()).config;
}

export interface PositionRow {
  id: string;
  preset: string;
  poolAddress: string;
  strategyType: string;
  sided: string;
  state: string;
  minBinId: number | null;
  maxBinId: number | null;
  binStep: number | null;
  entryPrice: number | null;
  lastPrice: number | null;
  depositSol: number;
  currentValueSol: number | null;
  feesEarnedSol: number;
  costsSol: number;
  hodlValueSol: number | null;
  timeInRangePct: number | null;
  realizedPnlSol: number;
  closeReason: string | null;
  openedAt: Date | null;
  closedAt: Date | null;
  /**
   * Ob die aus der Volatilität hergeleitete Breite an eine Leitplanke gestoßen
   * ist. Eine geklemmte Range ist nicht die Range, die der Markt verlangt —
   * ohne Ausweis sieht die Position aus wie jede andere.
   */
  binWidthClamped: "min" | "max" | null;
  /** Hergeleitete Bin-Zahl vor der Klemmung; `null` ohne Herleitung. */
  binWidthDerived: number | null;
}

/**
 * Liest die Herkunft der Bin-Breite aus dem serialisierten Zustand.
 *
 * Bewusst aus `simState` statt aus eigenen Spalten: Der Zustand ist ohnehin
 * vollständig gespeichert, und Positionen aus der Zeit vor diesem Feld haben
 * es schlicht nicht — sie liefern `null` statt einer erfundenen Angabe.
 */
function binWidthOf(simState: unknown): {
  binWidthClamped: "min" | "max" | null;
  binWidthDerived: number | null;
} {
  const state = simState as Record<string, unknown> | null | undefined;
  const clamped = state?.["binWidthClamped"];
  const derived = state?.["binWidthDerived"];
  return {
    binWidthClamped: clamped === "min" || clamped === "max" ? clamped : null,
    binWidthDerived: typeof derived === "number" && Number.isFinite(derived) ? derived : null,
  };
}

export async function listPositions(limit = 100): Promise<PositionRow[]> {
  const rows = await prisma().position.findMany({
    orderBy: [{ closedAt: "asc" }, { openedAt: "desc" }],
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    preset: row.preset,
    poolAddress: row.poolAddress,
    strategyType: row.strategyType,
    sided: row.sided,
    state: row.state,
    minBinId: row.minBinId,
    maxBinId: row.maxBinId,
    binStep: row.binStep,
    entryPrice: row.entryPrice === null ? null : Number(row.entryPrice),
    lastPrice: row.lastPrice === null ? null : Number(row.lastPrice),
    depositSol: Number(row.depositSol),
    currentValueSol: row.currentValueSol === null ? null : Number(row.currentValueSol),
    feesEarnedSol: Number(row.feesEarnedSol),
    costsSol: Number(row.costsSol),
    hodlValueSol: row.hodlValueSol === null ? null : Number(row.hodlValueSol),
    timeInRangePct: row.timeInRangePct === null ? null : Number(row.timeInRangePct),
    realizedPnlSol: Number(row.realizedPnlSol),
    closeReason: row.closeReason,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    ...binWidthOf(row.simState),
  }));
}

export async function presetPerformance(config: BotConfig): Promise<PresetPerformance[]> {
  const labels = Object.fromEntries(
    Object.entries(config.presets).map(([id, preset]) => [id, preset.label]),
  );
  const rows = await new PaperRepo(prisma()).performance(labels);
  // Presets ohne Positionen ebenfalls anzeigen — sonst wirkt ein Preset,
  // das noch nichts gefunden hat, als gäbe es ihn nicht.
  for (const [id, preset] of Object.entries(config.presets)) {
    if (!rows.some((row) => row.preset === id)) {
      rows.push({
        preset: id,
        label: preset.label,
        openPositions: 0,
        closedPositions: 0,
        realizedPnlSol: 0,
        unrealizedPnlSol: 0,
        totalPnlSol: 0,
        depositedSol: 0,
        feesEarnedSol: 0,
        costsSol: 0,
        wins: 0,
        losses: 0,
        winRatePct: null,
        avgTimeInRangePct: null,
        vsHodlSol: 0,
      });
    }
  }
  return rows.sort((a, b) => b.totalPnlSol - a.totalPnlSol);
}

export interface CandidateRow {
  id: string;
  poolAddress: string;
  preset: string;
  source: string;
  status: string;
  score: number | null;
  rejectionReason: string | null;
  discoveredAt: Date;
  shadowUntil: Date | null;
  metrics: { name?: string; tvlUsd?: number; volume24hUsd?: number; feeTvl24hPct?: number };
  screening: ScreeningResult | null;
}

export async function listCandidates(limit = 60): Promise<CandidateRow[]> {
  const rows = await prisma().poolCandidate.findMany({
    orderBy: { discoveredAt: "desc" },
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    poolAddress: row.poolAddress,
    preset: row.preset,
    source: row.source,
    status: row.status,
    score: row.score === null ? null : Number(row.score),
    rejectionReason: row.rejectionReason,
    discoveredAt: row.discoveredAt,
    shadowUntil: row.shadowUntil,
    metrics: (row.rawMetrics ?? {}) as CandidateRow["metrics"],
    screening: (row.filterResult ?? null) as ScreeningResult | null,
  }));
}

/** Freundlicher Hinweis statt Absturz, wenn die Datenbank fehlt. */
export async function dbAvailable(): Promise<{ ok: boolean; error?: string }> {
  if (process.env["DATABASE_URL"] === undefined || process.env["DATABASE_URL"] === "") {
    return { ok: false, error: "DATABASE_URL ist nicht gesetzt." };
  }
  try {
    await prisma().$queryRaw`SELECT 1`;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
