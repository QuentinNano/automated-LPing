import {
  aggregateMarket,
  classifyForPreset,
  screenCandidate,
  shortlistRank,
  tokenSideOf,
  type BotConfig,
  type CandidateSource,
  type MarketAggregates,
  type MarketPairSnapshot,
  type PoolMetrics,
  type PresetKind,
  type ScreeningResult,
  type SellabilityCheck,
  type TokenRiskReport,
} from "@lping/core";

/**
 * Ein Discovery→Enrichment→Screening-Durchlauf (KONZEPT.md Abschnitte 4, 5).
 * Quelle v1: eigene Replikation auf Meteora-Daten (Fabriq optional später).
 * Abhängigkeiten sind strukturell typisiert — Tests injizieren Fakes.
 */

export interface ScanDeps {
  meteora: {
    getPairsPage(params: {
      page?: number;
      limit?: number;
    }): Promise<{ pairs: PoolMetrics[]; skipped: number; total?: number }>;
  };
  dexscreener: {
    getPairsForToken(mint: string): Promise<{ pairs: MarketPairSnapshot[]; skipped: number }>;
  };
  rugcheck: { getReport(mint: string): Promise<TokenRiskReport> };
  jupiter: { checkSellability(mint: string): Promise<SellabilityCheck> };
  /** Optional: DB-Persistenz (ScanRepo aus @lping/db, strukturell typisiert). */
  persist?: {
    recordScreened(input: {
      poolAddress: string;
      preset: PresetKind;
      source: CandidateSource;
      pool: PoolMetrics;
      screening: ScreeningResult;
    }): Promise<unknown>;
  } | null;
  log?: (line: string) => void;
}

export interface ScanOptions {
  pages?: number;
  pageLimit?: number;
  topPerPreset?: number;
}

export interface ScanRow {
  preset: PresetKind;
  pool: PoolMetrics;
  tokenMint: string;
  screening: ScreeningResult;
}

export interface ScanSummary {
  poolsScanned: number;
  shortlisted: Record<PresetKind, number>;
  accepted: number;
  rejected: number;
  persisted: number;
  rows: ScanRow[];
}

/** IDs der aktiven Presets in Konfigurationsreihenfolge. */
export function activePresetIds(config: BotConfig): PresetKind[] {
  return Object.entries(config.presets)
    .filter(([, preset]) => preset.enabled)
    .map(([id]) => id);
}

interface Enrichment {
  market: MarketAggregates | null;
  risk: TokenRiskReport | null;
  sellability: SellabilityCheck | null;
}

export async function runScan(
  deps: ScanDeps,
  config: BotConfig,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const log = deps.log ?? (() => {});
  const pages = options.pages ?? 8;
  const pageLimit = options.pageLimit ?? 100;
  const topPerPreset = options.topPerPreset ?? 12;

  // 1) Discovery: Meteora-Pools seitenweise laden.
  const pools: PoolMetrics[] = [];
  for (let page = 0; page < pages; page++) {
    const result = await deps.meteora.getPairsPage({ page, limit: pageLimit });
    pools.push(...result.pairs);
    if (result.pairs.length < pageLimit) break;
  }
  log(`Discovery: ${pools.length} Pools geladen`);

  // 2) Vor-Filter + Shortlist je Preset (billig, rein lokal).
  const presetIds = activePresetIds(config);
  const shortlists: Record<PresetKind, PoolMetrics[]> = {};
  for (const id of presetIds) {
    const preset = config.presets[id]!;
    const eligible = pools.filter((pool) => classifyForPreset(pool, preset).eligible);
    shortlists[id] = eligible
      .sort((a, b) => shortlistRank(b) - shortlistRank(a))
      .slice(0, topPerPreset);
    log(`Shortlist ${id}: ${shortlists[id]!.length} von ${eligible.length} Kandidaten`);
  }

  // 3) Enrichment je Token (dedupliziert; sequenziell wegen Rate-Limits).
  const tokens = new Map<string, Enrichment>();
  for (const id of presetIds) {
    for (const pool of shortlists[id]!) {
      const mint = tokenSideOf(pool);
      if (mint !== null && !tokens.has(mint)) tokens.set(mint, { market: null, risk: null, sellability: null });
    }
  }
  let i = 0;
  for (const [mint, enrichment] of tokens) {
    i++;
    log(`Enrichment ${i}/${tokens.size}: ${mint.slice(0, 8)}…`);
    try {
      const { pairs } = await deps.dexscreener.getPairsForToken(mint);
      enrichment.market = aggregateMarket(mint, pairs);
    } catch (error) {
      log(`  dexscreener fehlgeschlagen: ${message(error)}`);
    }
    try {
      enrichment.risk = await deps.rugcheck.getReport(mint);
    } catch (error) {
      log(`  rugcheck fehlgeschlagen: ${message(error)}`);
    }
    try {
      enrichment.sellability = await deps.jupiter.checkSellability(mint);
    } catch (error) {
      log(`  jupiter fehlgeschlagen: ${message(error)}`);
    }
  }

  // 4) Screening + optionale Persistenz.
  const rows: ScanRow[] = [];
  let persisted = 0;
  let persistWarned = false;
  const source: CandidateSource = "replicated";
  for (const id of presetIds) {
    for (const pool of shortlists[id]!) {
      const tokenMint = tokenSideOf(pool);
      const enrichment = tokenMint !== null ? tokens.get(tokenMint) : undefined;
      const screening = screenCandidate({
        presetKind: id,
        preset: config.presets[id]!,
        global: config.global,
        source,
        pool,
        tokenMint,
        market: enrichment?.market ?? null,
        risk: enrichment?.risk ?? null,
        sellability: enrichment?.sellability ?? null,
      });
      rows.push({ preset: id, pool, tokenMint: tokenMint ?? "-", screening });

      if (deps.persist != null) {
        try {
          await deps.persist.recordScreened({
            poolAddress: pool.poolAddress,
            preset: id,
            source,
            pool,
            screening,
          });
          persisted++;
        } catch (error) {
          if (!persistWarned) {
            persistWarned = true;
            log(`Persistenz fehlgeschlagen (läuft ohne Shadow-Tracking weiter): ${message(error)}`);
          }
        }
      }
    }
  }

  rows.sort((a, b) => {
    if (a.screening.verdict !== b.screening.verdict) {
      return a.screening.verdict === "accepted" ? -1 : 1;
    }
    return b.screening.score.total - a.screening.score.total;
  });

  const shortlisted: Record<PresetKind, number> = {};
  for (const id of presetIds) shortlisted[id] = shortlists[id]!.length;

  return {
    poolsScanned: pools.length,
    shortlisted,
    accepted: rows.filter((r) => r.screening.verdict === "accepted").length,
    rejected: rows.filter((r) => r.screening.verdict === "rejected").length,
    persisted,
    rows,
  };
}

export function formatScanTable(summary: ScanSummary): string {
  const header = [
    pad("Preset", 12),
    pad("Pool", 22),
    pad("TVL $", 12),
    pad("Vol/TVL", 8),
    pad("Fee/TVL%", 9),
    pad("Score", 6),
    pad("Verdict", 9),
    "Grund",
  ].join(" ");
  const lines = [header, "-".repeat(header.length + 10)];

  for (const row of summary.rows) {
    const pool = row.pool;
    const volTvl =
      pool.tvlUsd !== undefined && pool.tvlUsd > 0 && pool.volume24hUsd !== undefined
        ? (pool.volume24hUsd / pool.tvlUsd).toFixed(1)
        : "?";
    const reasons =
      row.screening.rejectedBy.length > 0
        ? row.screening.rejectedBy.slice(0, 3).join(",") +
          (row.screening.rejectedBy.length > 3 ? ",…" : "")
        : "";
    lines.push(
      [
        pad(row.preset, 12),
        pad(pool.name ?? pool.poolAddress.slice(0, 10) + "…", 22),
        pad(formatUsd(pool.tvlUsd), 12),
        pad(volTvl, 8),
        pad(pool.feeTvl24hPct?.toFixed(2) ?? "?", 9),
        pad(row.screening.score.total.toFixed(1), 6),
        pad(row.screening.verdict === "accepted" ? "✓ OK" : "✗ raus", 9),
        reasons,
      ].join(" "),
    );
  }

  const shortlist = Object.entries(summary.shortlisted)
    .map(([id, count]) => `${id} ${count}`)
    .join(", ");
  lines.push(
    "",
    `Pools: ${summary.poolsScanned} gescannt | Shortlist ${shortlist} | ` +
      `akzeptiert ${summary.accepted}, abgelehnt ${summary.rejected} | ` +
      `persistiert ${summary.persisted}`,
  );
  return lines.join("\n");
}

function pad(value: string, width: number): string {
  return value.length > width ? value.slice(0, width - 1) + "…" : value.padEnd(width);
}

function formatUsd(value: number | undefined): string {
  if (value === undefined) return "?";
  if (value >= 1_000_000) return (value / 1_000_000).toFixed(2) + "M";
  if (value >= 1_000) return (value / 1_000).toFixed(0) + "k";
  return value.toFixed(0);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
