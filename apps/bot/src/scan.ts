import {
  aggregateMarket,
  buildDiscoveryFilter,
  buildFeatureVector,
  classifyForPreset,
  priceDivergencePct,
  screenCandidate,
  shortlistRank,
  tokenSideOf,
  DISCOVERY_STRATEGIES,
  FEATURE_VERSION,
  type BotConfig,
  type FeatureVector,
  type TokenOrganics,
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
      sortBy?: string;
      filterBy?: string;
    }): Promise<{
      pairs: PoolMetrics[];
      skipped: number;
      total?: number;
      /** Rohanzahl der Einträge — entscheidet über eine Folgeseite. */
      rawCount?: number;
      /** Ob die Quelle sort_by/filter_by unterstützt hat. */
      serverFiltered?: boolean;
    }>;
  };
  dexscreener: {
    getPairsForToken(mint: string): Promise<{ pairs: MarketPairSnapshot[]; skipped: number }>;
  };
  rugcheck: { getReport(mint: string): Promise<TokenRiskReport> };
  jupiter: { checkSellability(mint: string): Promise<SellabilityCheck> };
  /** Optional: Jupiter Token API v2 (Organic Score) — nur für die Aufzeichnung. */
  jupiterTokens?: { getOrganics(mint: string): Promise<TokenOrganics | null> } | null;
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
  /** Optional: Aufzeichnung für die Strategie-Optimierung (KONZEPT-ML.md M1). */
  track?: {
    recordFeatures(input: {
      poolAddress: string;
      tokenMint: string;
      preset: PresetKind;
      featureVersion: number;
      features: FeatureVector;
      score: number | null;
      verdict: string;
      rejectedBy: string[];
    }): Promise<unknown>;
    trackPool(poolAddress: string, tokenMint: string): Promise<unknown>;
  } | null;
  log?: (line: string) => void;
}

export interface ScanOptions {
  /** Seiten **je Discovery-Strategie**. */
  pages?: number;
  pageLimit?: number;
  topPerPreset?: number;
}

/** Ergebnis einer Discovery-Runde über alle Strategien. */
export interface DiscoveryResult {
  pools: PoolMetrics[];
  /** Neu gefundene Pools je Strategie (nach Dedupe gegen vorherige). */
  perStrategy: { id: string; found: number; added: number }[];
  /** Ob die Quelle serverseitig gefiltert hat. */
  serverFiltered: boolean;
  /** Angewandter `filter_by`-Ausdruck. */
  filter: string;
}

/**
 * Discovery über mehrere Sortierungen (KONZEPT.md 4.1).
 *
 * Der Filter läuft serverseitig, die Sortierungen werden zusammengeführt und
 * nach Pool-Adresse dedupliziert. Wichtig ist der Abbruch: Er hängt an der
 * **Rohanzahl** der Einträge, nicht an den verwertbaren — sonst beendet ein
 * einzelner unbrauchbarer Datensatz (etwa ein blacklisteter Pool) die Suche
 * mitten in der Liste.
 */
export async function discoverPools(
  deps: ScanDeps,
  config: BotConfig,
  options: ScanOptions = {},
): Promise<DiscoveryResult> {
  const log = deps.log ?? (() => {});
  const pagesPerStrategy = options.pages ?? 2;
  const pageLimit = options.pageLimit ?? 500;
  const filter = buildDiscoveryFilter(config);

  const byAddress = new Map<string, PoolMetrics>();
  const perStrategy: DiscoveryResult["perStrategy"] = [];
  let serverFiltered = true;

  for (const strategy of DISCOVERY_STRATEGIES) {
    const before = byAddress.size;
    let found = 0;

    for (let page = 0; page < pagesPerStrategy; page++) {
      const result = await deps.meteora.getPairsPage({
        page,
        limit: pageLimit,
        sortBy: strategy.sortBy,
        filterBy: filter,
      });
      found += result.pairs.length;
      for (const pool of result.pairs) {
        if (!byAddress.has(pool.poolAddress)) byAddress.set(pool.poolAddress, pool);
      }

      if (result.serverFiltered === false) serverFiltered = false;

      // Weniger Rohdatensätze als angefragt = letzte Seite.
      const raw = result.rawCount ?? result.pairs.length + result.skipped;
      if (raw < pageLimit) break;
      // Ohne serverseitige Sortierung liefert jede Seite dasselbe; dann bringt
      // eine zweite Strategie nichts und wir sparen die Abrufe.
      if (result.serverFiltered === false) break;
    }

    perStrategy.push({ id: strategy.id, found, added: byAddress.size - before });
    if (!serverFiltered) {
      log(
        `Discovery: Quelle ohne serverseitige Sortierung — nur eine Runde ` +
          `(${byAddress.size} Pools). Frische Pools können fehlen.`,
      );
      break;
    }
  }

  const pools = [...byAddress.values()];
  log(
    `Discovery: ${pools.length} Pools über ${perStrategy.length} Sortierung(en) ` +
      `[${perStrategy.map((s) => `${s.id} +${s.added}`).join(", ")}], Filter: ${filter}`,
  );

  return { pools, perStrategy, serverFiltered, filter };
}

export interface ScanRow {
  preset: PresetKind;
  pool: PoolMetrics;
  tokenMint: string;
  screening: ScreeningResult;
  /**
   * Geschätzte Tagesvolatilität des Tokens in %, sofern ableitbar.
   *
   * Wird beim Eröffnen gebraucht: Die Range-Breite folgt der Bewegung des
   * Marktes statt einer festen Bin-Zahl. Der Wert entsteht ohnehin im
   * Screening — ihn hier mitzugeben spart einen zweiten Abruf.
   */
  volatilityPctDaily: number | null;
}

export interface ScanSummary {
  poolsScanned: number;
  /** Wie die Grundgesamtheit zustande kam (Sortierungen, Filter). */
  discovery: Omit<DiscoveryResult, "pools">;
  shortlisted: Record<PresetKind, number>;
  /** Häufigste Ausschlussgründe des Vor-Filters je Preset (absteigend). */
  prefilterReasons: Record<PresetKind, [string, number][]>;
  accepted: number;
  rejected: number;
  persisted: number;
  /** Für die Optimierung aufgezeichnete Merkmalsvektoren. */
  tracked: number;
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
  organics: TokenOrganics | null;
}

export async function runScan(
  deps: ScanDeps,
  config: BotConfig,
  options: ScanOptions = {},
): Promise<ScanSummary> {
  const log = deps.log ?? (() => {});
  const topPerPreset = options.topPerPreset ?? 12;

  // 1) Discovery: mehrere Sortierungen serverseitig gefiltert zusammenführen.
  const discovery = await discoverPools(deps, config, options);
  const pools = discovery.pools;

  // 2) Vor-Filter + Shortlist je Preset (billig, rein lokal).
  const presetIds = activePresetIds(config);
  const shortlists: Record<PresetKind, PoolMetrics[]> = {};
  const prefilterReasons: Record<PresetKind, [string, number][]> = {};

  for (const id of presetIds) {
    const preset = config.presets[id]!;
    const eligible: PoolMetrics[] = [];
    // Ausschlussgründe zählen: eine leere Shortlist muss sich selbst erklären,
    // sonst steht man vor einem stummen "0 Kandidaten".
    const reasonCounts = new Map<string, number>();

    for (const pool of pools) {
      const result = classifyForPreset(pool, preset);
      if (result.eligible) {
        eligible.push(pool);
        continue;
      }
      for (const reason of result.reasons) {
        const kind = reason.split(" ")[0] ?? reason;
        reasonCounts.set(kind, (reasonCounts.get(kind) ?? 0) + 1);
      }
    }

    shortlists[id] = eligible
      .sort((a, b) => shortlistRank(b) - shortlistRank(a))
      .slice(0, topPerPreset);
    prefilterReasons[id] = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);

    log(`Shortlist ${id}: ${shortlists[id]!.length} von ${eligible.length} Kandidaten`);
    if (eligible.length === 0 && pools.length > 0) {
      const summary = prefilterReasons[id]!.map(([kind, count]) => `${kind} (${count}×)`).join(", ");
      log(`  → kein Pool passt zu "${id}". Häufigste Ausschlussgründe: ${summary || "keine"}`);
    }
  }

  // 3) Enrichment je Token (dedupliziert; sequenziell wegen Rate-Limits).
  const tokens = new Map<string, Enrichment>();
  for (const id of presetIds) {
    for (const pool of shortlists[id]!) {
      const mint = tokenSideOf(pool);
      if (mint !== null && !tokens.has(mint)) {
        tokens.set(mint, { market: null, risk: null, sellability: null, organics: null });
      }
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
    if (deps.jupiterTokens != null) {
      try {
        enrichment.organics = await deps.jupiterTokens.getOrganics(mint);
      } catch (error) {
        // Rein informativ: der Organic Score ist ein Merkmal, kein Filter.
        log(`  organic score nicht abrufbar: ${message(error)}`);
      }
    }
  }

  // 4) Screening + optionale Persistenz.
  const rows: ScanRow[] = [];
  let persisted = 0;
  let persistWarned = false;
  let tracked = 0;
  let trackWarned = false;
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
      rows.push({
        preset: id,
        pool,
        tokenMint: tokenMint ?? "-",
        screening,
        volatilityPctDaily: enrichment?.market?.volatilityPctDaily ?? null,
      });

      // Aufzeichnung für die spätere Optimierung: Merkmale JEDES gescreenten
      // Kandidaten, unabhängig vom Urteil (KONZEPT-ML.md Abschnitt 3.1).
      if (deps.track != null && tokenMint !== null) {
        try {
          const features = buildFeatureVector({
            pool,
            market: enrichment?.market ?? null,
            risk: enrichment?.risk ?? null,
            sellability: enrichment?.sellability ?? null,
            organics: enrichment?.organics ?? null,
            priceDivergencePct:
              enrichment?.market != null ? priceDivergencePct(pool, enrichment.market) : null,
          });
          await deps.track.recordFeatures({
            poolAddress: pool.poolAddress,
            tokenMint,
            preset: id,
            featureVersion: FEATURE_VERSION,
            features,
            score: screening.score.total,
            verdict: screening.verdict,
            rejectedBy: screening.rejectedBy,
          });
          await deps.track.trackPool(pool.poolAddress, tokenMint);
          tracked++;
        } catch (error) {
          if (!trackWarned) {
            trackWarned = true;
            log(`Aufzeichnung fehlgeschlagen (Scan läuft weiter): ${message(error)}`);
          }
        }
      }

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
    discovery: {
      perStrategy: discovery.perStrategy,
      serverFiltered: discovery.serverFiltered,
      filter: discovery.filter,
    },
    shortlisted,
    prefilterReasons,
    accepted: rows.filter((r) => r.screening.verdict === "accepted").length,
    rejected: rows.filter((r) => r.screening.verdict === "rejected").length,
    persisted,
    tracked,
    rows,
  };
}

export function formatScanTable(summary: ScanSummary): string {
  if (summary.rows.length === 0) {
    const lines = [
      `Kein Pool hat den Vor-Filter passiert (${summary.poolsScanned} Pools geladen).`,
      "",
    ];
    if (summary.poolsScanned === 0) {
      lines.push(
        "Es kamen gar keine Pools an — die Datenquelle prüfen:",
        "  pnpm --filter @lping/bot api:check",
      );
    } else {
      lines.push("Häufigste Ausschlussgründe je Preset:");
      for (const [preset, reasons] of Object.entries(summary.prefilterReasons)) {
        const summaryText = reasons.map(([kind, count]) => `${kind} (${count}×)`).join(", ");
        lines.push(`  ${preset.padEnd(12)} ${summaryText || "—"}`);
      }
      lines.push(
        "",
        "Das kann normal sein (die Filter sind bewusst streng) oder daran liegen,",
        "dass ein Feld aus der API nicht gelesen wird. Zum Nachsehen:",
        "  pnpm --filter @lping/bot api:check",
      );
    }
    return lines.join("\n");
  }

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
      `persistiert ${summary.persisted}` +
      (summary.tracked > 0 ? ` | aufgezeichnet ${summary.tracked}` : ""),
    formatDiscovery(summary.discovery),
  );
  return lines.join("\n");
}

/**
 * Welche Sortierung welche Pools beigetragen hat. Steht in der Ausgabe, weil
 * "die Discovery findet nichts Frisches" sonst nicht von "es gibt nichts
 * Frisches" zu unterscheiden ist.
 */
function formatDiscovery(discovery: ScanSummary["discovery"]): string {
  const parts = discovery.perStrategy.map((s) => `${s.id} +${s.added}/${s.found}`).join(", ");
  const base = `Discovery: ${parts || "—"} | Filter ${discovery.filter}`;
  return discovery.serverFiltered
    ? base
    : `${base}\n! Quelle ohne serverseitige Sortierung (ältere Schnittstelle) — frische Pools können fehlen.`;
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
