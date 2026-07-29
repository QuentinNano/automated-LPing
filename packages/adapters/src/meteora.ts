import { z } from "zod";
import type { AdapterHealth, PoolMetrics } from "@lping/core";
import { AdapterError, TokenBucket, fetchJson, type FetchLike } from "./http";

/**
 * Meteora-Pool-Metriken für Discovery und Scoring.
 *
 * Meteora betreibt zwei HTTP-Schnittstellen nebeneinander, deren Feldnamen
 * sich unterscheiden:
 *   - `dlmm.datapi.meteora.ag/pools` — aktuell, paginiert (Seiten 1-basiert),
 *     Envelope `{ data, total, pages, current_page, page_size }`
 *   - `dlmm-api.meteora.ag/pair/all` — älter, liefert alle Paare am Stück
 *
 * Der Adapter probiert sie der Reihe nach und merkt sich die funktionierende
 * Quelle. Keine der beiden ist formal versioniert — deshalb werden Felder über
 * Alias-Listen gelesen statt über ein starres Schema, und ein Datensatz, dem
 * Pflichtangaben fehlen, wird übersprungen statt den ganzen Abruf zu verwerfen.
 */

export interface MeteoraPairsPage {
  pairs: PoolMetrics[];
  total?: number;
  /** Anzahl Einträge, aus denen sich keine Pool-Metriken lesen ließen. */
  skipped: number;
  /** Welche Schnittstelle die Daten geliefert hat. */
  source: MeteoraSourceId;
}

export type MeteoraSourceId = "datapi" | "legacy";

interface MeteoraSource {
  id: MeteoraSourceId;
  baseUrl: string;
  listPath: string;
  poolPath: (address: string) => string;
  /** Query-Parameter für eine Seite; null = Endpunkt kennt keine Pagination. */
  listParams: ((page: number, limit: number) => Record<string, string | number>) | null;
}

const SOURCES: MeteoraSource[] = [
  {
    id: "datapi",
    baseUrl: "https://dlmm.datapi.meteora.ag",
    listPath: "/pools",
    poolPath: (address) => `/pools/${address}`,
    // Seiten sind 1-basiert; nach Volumen sortiert kommen die aktivsten zuerst.
    listParams: (page, limit) => ({
      page: page + 1,
      page_size: limit,
      sort_by: "volume_24h:desc",
    }),
  },
  {
    id: "legacy",
    baseUrl: "https://dlmm-api.meteora.ag",
    listPath: "/pair/all",
    poolPath: (address) => `/pair/${address}`,
    listParams: null,
  },
];

export interface MeteoraAdapterOptions {
  /** Überschreibt die Basis-URLs (Tests, eigene Proxys). */
  sources?: MeteoraSource[];
  limiter?: TokenBucket;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class MeteoraAdapter {
  private readonly sources: MeteoraSource[];
  private readonly limiter: TokenBucket;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number | undefined;
  /** Zuletzt erfolgreiche Quelle — wird beim nächsten Aufruf zuerst versucht. */
  private preferred: MeteoraSourceId | null = null;

  constructor(options: MeteoraAdapterOptions = {}) {
    this.sources = options.sources ?? SOURCES;
    this.limiter = options.limiter ?? new TokenBucket(2);
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
  }

  private orderedSources(): MeteoraSource[] {
    if (this.preferred === null) return this.sources;
    const preferred = this.sources.filter((s) => s.id === this.preferred);
    return [...preferred, ...this.sources.filter((s) => s.id !== this.preferred)];
  }

  private requestOptions() {
    return {
      limiter: this.limiter,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    };
  }

  async getPair(address: string): Promise<PoolMetrics> {
    let lastError: unknown;
    for (const source of this.orderedSources()) {
      try {
        const payload = await fetchJson(`${source.baseUrl}${source.poolPath(address)}`, {
          schema: z.unknown(),
          ...this.requestOptions(),
        });
        const pool = normalizeMeteoraPair(unwrapSingle(payload));
        if (pool === null) {
          throw new AdapterError("Pool-Antwort ohne verwertbare Felder", "validation", {
            url: `${source.baseUrl}${source.poolPath(address)}`,
          });
        }
        this.preferred = source.id;
        return pool;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error(`Pool ${address} nicht abrufbar`);
  }

  async getPairsPage(params: { page?: number; limit?: number } = {}): Promise<MeteoraPairsPage> {
    const page = params.page ?? 0;
    const limit = params.limit ?? 50;

    let lastError: unknown;
    for (const source of this.orderedSources()) {
      const url = `${source.baseUrl}${source.listPath}`;
      try {
        const payload = await fetchJson(url, {
          schema: z.unknown(),
          ...(source.listParams !== null ? { searchParams: source.listParams(page, limit) } : {}),
          ...this.requestOptions(),
        });

        const { items, total } = unwrapList(payload, url);
        // Endpunkte ohne Pagination liefern alles auf einmal.
        const slice =
          source.listParams === null ? items.slice(page * limit, (page + 1) * limit) : items;

        const pairs: PoolMetrics[] = [];
        let skipped = 0;
        for (const item of slice) {
          const pool = normalizeMeteoraPair(item);
          if (pool !== null) pairs.push(pool);
          else skipped++;
        }

        this.preferred = source.id;
        return {
          pairs,
          skipped,
          source: source.id,
          ...(total !== undefined
            ? { total }
            : source.listParams === null
              ? { total: items.length }
              : {}),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new AdapterError("Keine Meteora-Schnittstelle erreichbar", "network", {
      url: this.sources[0]?.baseUrl ?? "",
    });
  }

  async health(): Promise<AdapterHealth> {
    const started = Date.now();
    try {
      const page = await this.getPairsPage({ limit: 1 });
      return {
        adapter: "meteora",
        ok: true,
        latencyMs: Date.now() - started,
        note: `Quelle: ${page.source}`,
      };
    } catch (error) {
      return {
        adapter: "meteora",
        ok: false,
        latencyMs: Date.now() - started,
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

/** Envelope einer Listenantwort auspacken (nacktes Array oder `{data|pairs|…}`). */
function unwrapList(payload: unknown, url: string): { items: unknown[]; total?: number } {
  if (Array.isArray(payload)) return { items: payload };
  if (isRecord(payload)) {
    for (const key of ["data", "pairs", "pools", "groups", "items", "results"]) {
      const value = payload[key];
      if (Array.isArray(value)) {
        const total = pickNumber([payload], ["total", "total_count", "count"]);
        return { items: value, ...(total !== undefined ? { total } : {}) };
      }
    }
  }
  throw new AdapterError("Unerwartete Envelope-Form der Pool-Liste", "validation", { url });
}

/** Einzelantwort auspacken (manche Endpunkte verpacken sie in `{data: …}`). */
function unwrapSingle(payload: unknown): unknown {
  if (isRecord(payload) && isRecord(payload["data"])) return payload["data"];
  return payload;
}

/**
 * Liest Pool-Metriken aus einem Datensatz beider Schnittstellen.
 * Gibt `null` zurück, wenn Pflichtangaben (Adresse, beide Mints, Bin Step)
 * fehlen — dann ist der Datensatz für uns unbrauchbar.
 */
export function normalizeMeteoraPair(raw: unknown): PoolMetrics | null {
  if (!isRecord(raw)) return null;

  // Meteora markiert problematische Pools selbst — die überspringen wir sofort.
  if (raw["is_blacklisted"] === true) return null;

  const scopes = scopesOf(raw);

  const poolAddress = pickString(scopes, ["address", "pool_address", "pubkey", "lb_pair", "lbPair"]);
  const mintX = pickMint(scopes, ["token_x", "mint_x", "mintX", "token_x_mint", "tokenX", "base_mint"]);
  const mintY = pickMint(scopes, ["token_y", "mint_y", "mintY", "token_y_mint", "tokenY", "quote_mint"]);
  const binStep = pickNumber(scopes, ["bin_step", "binStep"]);

  if (poolAddress === undefined || mintX === undefined || mintY === undefined || binStep === undefined) {
    return null;
  }

  const tvlUsd = pickNumber(scopes, ["tvl", "liquidity", "tvl_usd", "liquidity_usd"]);
  const volume24hUsd = pickNumber(scopes, ["volume", "trade_volume_24h", "volume_24h", "volume24h"]);
  const fees24hUsd = pickNumber(scopes, ["fees", "fees_24h", "fee_24h", "fees24h"]);

  // Die API liefert das Fee/TVL-Verhältnis teils fertig; sonst selbst rechnen.
  const reportedRatio = pickNumber(scopes, ["fee_tvl_ratio", "fee_tvl_ratio_24h"]);
  const feeTvl24hPct =
    reportedRatio ??
    (tvlUsd !== undefined && tvlUsd > 0 && fees24hUsd !== undefined
      ? (fees24hUsd / tvlUsd) * 100
      : undefined);

  const name = pickString(scopes, ["name", "pair_name", "symbol"]);
  const baseFeePct = pickNumber(scopes, [
    "base_fee_pct",
    "base_fee_percentage",
    "base_fee",
    // Fällt die Basisgebühr aus, ist die aktuelle dynamische Gebühr die beste
    // verfügbare Näherung für die Ertragskraft des Pools.
    "dynamic_fee_pct",
    "current_fee_pct",
  ]);
  const maxFeePct = pickNumber(scopes, ["max_fee_pct", "max_fee_percentage", "max_fee"]);
  const priceNative = pickNumber(scopes, ["current_price", "price", "price_native"]);
  const apr = pickNumber(scopes, ["apr", "apr_24h"]);
  const apy = pickNumber(scopes, ["apy", "apy_24h"]);

  return {
    poolAddress,
    mintX,
    mintY,
    binStep,
    fetchedAt: new Date(),
    source: "meteora",
    ...(name !== undefined ? { name } : {}),
    ...(baseFeePct !== undefined ? { baseFeePct } : {}),
    ...(maxFeePct !== undefined ? { maxFeePct } : {}),
    ...(tvlUsd !== undefined ? { tvlUsd } : {}),
    ...(volume24hUsd !== undefined ? { volume24hUsd } : {}),
    ...(fees24hUsd !== undefined ? { fees24hUsd } : {}),
    ...(feeTvl24hPct !== undefined ? { feeTvl24hPct } : {}),
    ...(priceNative !== undefined ? { priceNative } : {}),
    ...(apr !== undefined ? { apr } : {}),
    ...(apy !== undefined ? { apy } : {}),
  };
}

/**
 * Kennzahlen liegen je nach Schnittstelle flach (`volume_24h: 1234`) oder als
 * Objekt mit Zeitfenstern (`volume: { hour_1: …, hour_24: … }`). Diese Liste
 * deckt die gebräuchlichen Schreibweisen des 24-Stunden-Fensters ab.
 */
const WINDOW_24H_KEYS = [
  "hour_24",
  "h24",
  "24h",
  "hour24",
  "last_24h",
  "day_1",
  "d1",
  "min_1440",
];

/**
 * Verschachtelte Container, in denen Felder ebenfalls stehen können —
 * `bin_step` und die Basisgebühr liegen bei der aktuellen API in `pool_config`.
 */
const NESTED_SCOPES = ["pool_config", "config", "pair", "pool", "metrics"];

/** Der Datensatz selbst plus seine bekannten Unter-Container. */
function scopesOf(raw: Record<string, unknown>): Record<string, unknown>[] {
  const scopes = [raw];
  for (const key of NESTED_SCOPES) {
    const value = raw[key];
    if (isRecord(value)) scopes.push(value);
  }
  return scopes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // Beide Schnittstellen liefern Zahlen teils als Strings.
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

// Wichtig bei allen drei Zugriffen: die **Schlüssel-Reihenfolge** hat Vorrang
// vor dem Container. Sonst gewönne z. B. das oberflächlich liegende
// `dynamic_fee_pct` gegen das präzisere `base_fee_pct` aus `pool_config`.

function pickString(scopes: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const key of keys) {
    for (const scope of scopes) {
      const value = scope[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * Zahl aus einem der Container lesen — direkt, oder aus dem 24-Stunden-Fenster
 * eines Kennzahlen-Objekts.
 */
function pickNumber(scopes: Record<string, unknown>[], keys: string[]): number | undefined {
  for (const key of keys) {
    for (const scope of scopes) {
      const value = scope[key];
      const direct = toNumber(value);
      if (direct !== undefined) return direct;
      if (isRecord(value)) {
        for (const window of WINDOW_24H_KEYS) {
          const windowed = toNumber(value[window]);
          if (windowed !== undefined) return windowed;
        }
      }
    }
  }
  return undefined;
}

/** Mint-Adresse, auch wenn sie in einem Token-Objekt steckt. */
function pickMint(scopes: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const key of keys) {
    for (const scope of scopes) {
      const value = scope[key];
      if (typeof value === "string" && value.length > 0) return value;
      if (isRecord(value)) {
        const nested = pickString([value], ["address", "mint", "mint_address", "mint_x", "mint_y"]);
        if (nested !== undefined) return nested;
      }
    }
  }
  return undefined;
}
