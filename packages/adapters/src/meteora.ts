import { z } from "zod";
import {
  METRIC_WINDOWS,
  type AdapterHealth,
  type CollectFeeMode,
  type HistoryTimeframe,
  type MetricWindow,
  type PoolCandle,
  type PoolMetrics,
  type PoolTokenInfo,
  type PortfolioPool,
  type RealPosition,
  type WindowedMetric,
} from "@lping/core";
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
  /**
   * Rohanzahl der Einträge dieser Seite (verwertbare + übersprungene).
   * Die Pagination muss hieran entscheiden, ob eine weitere Seite folgt:
   * `pairs.length` allein bricht zu früh ab, sobald ein Datensatz unbrauchbar
   * ist — und genau das ist bei blacklisteten Pools der Normalfall.
   */
  rawCount: number;
  /** Welche Schnittstelle die Daten geliefert hat. */
  source: MeteoraSourceId;
  /** Ob die Quelle die serverseitigen Filter/Sortierungen unterstützt. */
  serverFiltered: boolean;
}

/**
 * Abfrageparameter der aktuellen datapi-Schnittstelle.
 *
 * `sortBy`/`filterBy` verlagern die Vorauswahl auf den Server. Das ist der
 * Unterschied zwischen "die 800 volumenstärksten Pools ansehen" und "die
 * Pools ansehen, die zum Preset passen": frische Degen-Pools stehen in einer
 * Sortierung nach 24-Stunden-Volumen weit hinten und wurden bislang nie
 * erreicht.
 */
export interface MeteoraListQuery {
  page?: number;
  limit?: number;
  /** z. B. `volume_24h:desc`, `fee_tvl_ratio_1h:desc`, `pool_created_at:desc`. */
  sortBy?: string;
  /** z. B. `is_blacklisted=false && tvl>=25000`. */
  filterBy?: string;
}

/**
 * Zeitraum-Abfrage der Historien-Endpunkte.
 *
 * Beide Grenzen sind optional und inklusiv. Fehlt eine, leitet die API sie aus
 * `timeframe` ab; fehlen beide, liefert sie einen Standardbereich. Für
 * reproduzierbares Nachladen sollten beide gesetzt sein.
 */
export interface HistoryQuery {
  timeframe: HistoryTimeframe;
  startTime?: Date;
  endTime?: Date;
}

export interface OhlcvRow {
  ts: Date;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volumeUsd: number | null;
}

export interface VolumeHistoryRow {
  ts: Date;
  volumeUsd: number | null;
  feesUsd: number | null;
  protocolFeesUsd: number | null;
}

export type MeteoraSourceId = "datapi" | "legacy";

interface MeteoraSource {
  id: MeteoraSourceId;
  baseUrl: string;
  listPath: string;
  poolPath: (address: string) => string;
  /** Query-Parameter für eine Seite; null = Endpunkt kennt keine Pagination. */
  listParams: ((query: MeteoraListQuery) => Record<string, string | number>) | null;
  /** Historien-Endpunkte — nur die aktuelle Schnittstelle hat sie. */
  ohlcvPath?: (address: string) => string;
  volumeHistoryPath?: (address: string) => string;
  /** Positions-Endpunkte für die Ground-Truth-Kalibrierung. */
  openPortfolioPath?: string;
  closedPortfolioPath?: string;
  positionPnlPath?: (poolAddress: string) => string;
}

/** Obergrenze der dokumentierten Schnittstelle für `page_size`. */
export const MAX_POOL_PAGE_SIZE = 1000;

/**
 * Anfragen pro Sekunde im Normalbetrieb.
 *
 * Dokumentiert sind 30 RPS für alle DLMM-APIs. Der Abstand nach unten ist
 * Absicht: Discovery, Aufzeichnung und Nachladen teilen sich das Budget, und ein
 * 429 kostet mehr als er einspart. Wer mehr braucht, setzt einen eigenen
 * `limiter`.
 */
export const DEFAULT_RATE_PER_SEC = 20;

/**
 * Wie viele Pool-Adressen in einen `filter_by`-Ausdruck gehen.
 *
 * Begrenzt wird nicht durch die API, sondern durch die URL-Länge: Eine
 * Solana-Adresse ist 32–44 Zeichen, 40 davon plus Trennzeichen bleiben mit
 * ~1,8 kB deutlich unter jeder üblichen Grenze.
 */
export const MAX_ADDRESSES_PER_QUERY = 40;

const SOURCES: MeteoraSource[] = [
  {
    id: "datapi",
    baseUrl: "https://dlmm.datapi.meteora.ag",
    listPath: "/pools",
    poolPath: (address) => `/pools/${address}`,
    ohlcvPath: (address) => `/pools/${address}/ohlcv`,
    volumeHistoryPath: (address) => `/pools/${address}/volume/history`,
    openPortfolioPath: "/portfolio/open",
    closedPortfolioPath: "/portfolio",
    positionPnlPath: (poolAddress) => `/positions/${poolAddress}/pnl`,
    // Seiten sind 1-basiert. Sortierung und Filter sind serverseitig, damit die
    // Vorauswahl nicht davon abhängt, was in den ersten Seiten zufällig steht.
    listParams: ({ page = 0, limit = 50, sortBy, filterBy }) => ({
      page: page + 1,
      page_size: Math.min(limit, MAX_POOL_PAGE_SIZE),
      sort_by: sortBy ?? "volume_24h:desc",
      ...(filterBy !== undefined && filterBy !== "" ? { filter_by: filterBy } : {}),
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
    this.limiter = options.limiter ?? new TokenBucket(DEFAULT_RATE_PER_SEC);
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

  async getPairsPage(params: MeteoraListQuery = {}): Promise<MeteoraPairsPage> {
    const page = params.page ?? 0;
    const limit = params.limit ?? 50;

    let lastError: unknown;
    for (const source of this.orderedSources()) {
      const url = `${source.baseUrl}${source.listPath}`;
      try {
        const payload = await fetchJson(url, {
          schema: z.unknown(),
          ...(source.listParams !== null
            ? { searchParams: source.listParams({ ...params, page, limit }) }
            : {}),
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
          rawCount: slice.length,
          source: source.id,
          // Die ältere Schnittstelle kennt weder sort_by noch filter_by; sie
          // liefert ungefiltert. Der Aufrufer muss deshalb weiterhin selbst
          // filtern — serverseitige Filter sind Vorauswahl, nie Entscheidung.
          serverFiltered: source.listParams !== null,
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

  /**
   * Pool-Metriken für viele Adressen auf einmal.
   *
   * Der Unterschied zu N × `getPair` ist der Grund für diese Methode: Die
   * Aufzeichnung braucht je Messrunde einen Wert für **jeden** verfolgten Pool.
   * Einzeln abgefragt sind 2.000 Pools 2.000 Anfragen und sprengen jedes
   * Zeitraster; über `filter_by=pool_address=[…]` sind es 50.
   *
   * Adressen, die die API nicht kennt (Pool entfernt, Tippfehler), fehlen im
   * Ergebnis. Der Aufrufer muss die Differenz selbst bilden — stillschweigend
   * fehlende Messpunkte wären schlimmer als ein gemeldeter Fehlversuch.
   */
  async getPairsByAddresses(addresses: string[]): Promise<PoolMetrics[]> {
    const unique = [...new Set(addresses)].filter((address) => address.length > 0);
    const pools: PoolMetrics[] = [];

    for (let i = 0; i < unique.length; i += MAX_ADDRESSES_PER_QUERY) {
      const chunk = unique.slice(i, i + MAX_ADDRESSES_PER_QUERY);
      const page = await this.getPairsPage({
        page: 0,
        limit: Math.min(chunk.length, MAX_POOL_PAGE_SIZE),
        filterBy: `pool_address=[${chunk.join("|")}]`,
      });

      if (!page.serverFiltered) {
        // Die ältere Schnittstelle kennt `filter_by` nicht und hätte irgendeine
        // Seite geliefert. Ein falscher Pool ist schlimmer als keiner.
        throw new AdapterError(
          "Sammelabruf braucht die aktuelle Schnittstelle (filter_by)",
          "validation",
          { url: `${this.sources[0]?.baseUrl ?? ""}/pools` },
        );
      }

      const wanted = new Set(chunk);
      for (const pool of page.pairs) {
        if (wanted.has(pool.poolAddress)) pools.push(pool);
      }
    }

    return pools;
  }

  /**
   * Kerzen der Pool-Historie: Preis aus `/ohlcv`, Volumen und Gebühren aus
   * `/volume/history`, über den Zeitstempel zusammengeführt.
   *
   * Beide Endpunkte rastern identisch, liefern aber getrennt — und der Replay
   * braucht beides je Fenster. Fehlt eine Seite, entstehen trotzdem Kerzen: Ein
   * Preisverlauf ohne Gebühren ist unvollständig, aber nicht wertlos, und
   * `null` sagt das ehrlich.
   */
  async getHistory(
    address: string,
    options: HistoryQuery,
  ): Promise<PoolCandle[]> {
    const [prices, volumes] = await Promise.all([
      this.getOhlcv(address, options),
      this.getVolumeHistory(address, options),
    ]);

    const byTs = new Map<number, PoolCandle>();
    for (const row of prices) {
      byTs.set(row.ts.getTime(), {
        poolAddress: address,
        ts: row.ts,
        timeframe: options.timeframe,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volumeUsd: row.volumeUsd,
        feesUsd: null,
        protocolFeesUsd: null,
      });
    }

    for (const row of volumes) {
      const key = row.ts.getTime();
      const existing = byTs.get(key);
      if (existing === undefined) {
        byTs.set(key, {
          poolAddress: address,
          ts: row.ts,
          timeframe: options.timeframe,
          open: null,
          high: null,
          low: null,
          close: null,
          volumeUsd: row.volumeUsd,
          feesUsd: row.feesUsd,
          protocolFeesUsd: row.protocolFeesUsd,
        });
        continue;
      }
      existing.feesUsd = row.feesUsd;
      existing.protocolFeesUsd = row.protocolFeesUsd;
      // Das Volumen steht in beiden Antworten; die Gebühren-Historie ist die
      // Quelle, zu der die Gebühren gehören — sonst wäre der Satz aus zwei
      // verschiedenen Antworten zusammengerechnet.
      if (row.volumeUsd !== null) existing.volumeUsd = row.volumeUsd;
    }

    return [...byTs.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  }

  /** Preiskerzen (`/pools/{address}/ohlcv`). */
  async getOhlcv(address: string, options: HistoryQuery): Promise<OhlcvRow[]> {
    const payload = await this.fetchHistory(
      address,
      options,
      (source) => source.ohlcvPath,
      "ohlcv",
    );
    return payload.flatMap((raw) => {
      const ts = historyTimestamp(raw);
      if (ts === null) return [];
      return [
        {
          ts,
          open: nullableNumber(raw["open"]),
          high: nullableNumber(raw["high"]),
          low: nullableNumber(raw["low"]),
          close: nullableNumber(raw["close"]),
          volumeUsd: nullableNumber(raw["volume"]),
        },
      ];
    });
  }

  /** Volumen-, Gebühren- und Protokollgebühren-Historie. */
  async getVolumeHistory(address: string, options: HistoryQuery): Promise<VolumeHistoryRow[]> {
    const payload = await this.fetchHistory(
      address,
      options,
      (source) => source.volumeHistoryPath,
      "volume/history",
    );
    return payload.flatMap((raw) => {
      const ts = historyTimestamp(raw);
      if (ts === null) return [];
      return [
        {
          ts,
          volumeUsd: nullableNumber(raw["volume"]),
          feesUsd: nullableNumber(raw["fees"]),
          protocolFeesUsd: nullableNumber(raw["protocol_fees"]),
        },
      ];
    });
  }

  /**
   * Gemeinsamer Abrufpfad beider Historien-Endpunkte.
   *
   * Es wird nur die Quelle versucht, die sie überhaupt hat: Die ältere
   * Schnittstelle kennt keine Historie, und ein Rückfall auf sie würde einen
   * 404 in einen unverständlichen Fehler verwandeln.
   */
  private async fetchHistory(
    address: string,
    options: HistoryQuery,
    pathOf: (source: MeteoraSource) => ((address: string) => string) | undefined,
    label: string,
  ): Promise<Record<string, unknown>[]> {
    const source = this.sources.find((candidate) => pathOf(candidate) !== undefined);
    const path = source === undefined ? undefined : pathOf(source);
    if (source === undefined || path === undefined) {
      throw new AdapterError(
        `Keine Schnittstelle mit ${label}-Historie konfiguriert`,
        "validation",
        { url: label },
      );
    }

    const url = `${source.baseUrl}${path(address)}`;
    const payload = await fetchJson(url, {
      schema: z.unknown(),
      searchParams: {
        timeframe: options.timeframe,
        ...(options.startTime !== undefined
          ? { start_time: Math.floor(options.startTime.getTime() / 1000) }
          : {}),
        ...(options.endTime !== undefined
          ? { end_time: Math.floor(options.endTime.getTime() / 1000) }
          : {}),
      },
      ...this.requestOptions(),
    });

    const { items } = unwrapList(payload, url);
    return items.filter(isRecord);
  }

  /**
   * Pools, in denen ein Wallet Positionen hält (`open`) oder hielt (`closed`).
   *
   * Einstiegspunkt der Ground-Truth-Kalibrierung: Von hier führt der Weg über
   * `getPositions` zu den einzelnen Positionen mit ihrem Gebührenertrag.
   *
   * **Zum Feldnamen-Risiko.** Diese Endpunkte sind wie alle Meteora-APIs nicht
   * formal versioniert, und ihre Antwortform ließ sich hier nicht gegen den
   * Live-Dienst prüfen. Gelesen wird deshalb wie überall über Alias-Listen, und
   * ein Datensatz ohne Pflichtangaben wird übersprungen statt den ganzen Abruf
   * zu verwerfen. `pnpm --filter @lping/bot api:check` zeigt im Zweifel, was
   * tatsächlich ankommt.
   */
  async getPortfolio(
    wallet: string,
    options: { status?: "open" | "closed"; page?: number; pageSize?: number } = {},
  ): Promise<PortfolioPool[]> {
    const status = options.status ?? "open";
    const source = this.sources.find((candidate) =>
      status === "open" ? candidate.openPortfolioPath : candidate.closedPortfolioPath,
    );
    const path = status === "open" ? source?.openPortfolioPath : source?.closedPortfolioPath;
    if (source === undefined || path === undefined) {
      throw new AdapterError("Keine Schnittstelle mit Portfolio-Endpunkt", "validation", {
        url: "portfolio",
      });
    }

    const url = `${source.baseUrl}${path}`;
    const payload = await fetchJson(url, {
      schema: z.unknown(),
      searchParams: {
        user: wallet,
        page: options.page ?? 1,
        ...(options.pageSize !== undefined ? { page_size: options.pageSize } : {}),
      },
      ...this.requestOptions(),
    });

    return unwrapList(payload, url)
      .items.filter(isRecord)
      .flatMap((raw) => {
        const scopes = scopesOf(raw);
        const poolAddress = pickString(scopes, [
          "pool_address",
          "address",
          "lb_pair",
          "lbPair",
          "pair_address",
        ]);
        if (poolAddress === undefined) return [];
        return [{ poolAddress, positionAddresses: positionAddressesOf(raw) }];
      });
  }

  /**
   * Positionen eines Wallets in einem Pool, samt PnL und Gebührenertrag.
   *
   * Geschlossene Positionen sind die wertvolleren: Sie haben einen Anfang, ein
   * Ende und einen abgeschlossenen Gebührenertrag — genau die drei Angaben, die
   * ein Replay derselben Zeitspanne braucht, um vergleichbar zu sein.
   */
  async getPositions(
    poolAddress: string,
    wallet: string,
    options: { status?: "open" | "closed"; page?: number } = {},
  ): Promise<RealPosition[]> {
    const source = this.sources.find((candidate) => candidate.positionPnlPath !== undefined);
    const path = source?.positionPnlPath;
    if (source === undefined || path === undefined) {
      throw new AdapterError("Keine Schnittstelle mit Positions-PnL", "validation", {
        url: "positions/pnl",
      });
    }

    const url = `${source.baseUrl}${path(poolAddress)}`;
    const payload = await fetchJson(url, {
      schema: z.unknown(),
      searchParams: {
        user: wallet,
        page: options.page ?? 1,
        ...(options.status !== undefined ? { status: options.status } : {}),
      },
      ...this.requestOptions(),
    });

    return unwrapList(payload, url)
      .items.filter(isRecord)
      .flatMap((raw) => {
        const position = normalizeRealPosition(raw, poolAddress);
        return position === null ? [] : [position];
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

/** Positionsadressen eines Portfolio-Eintrags, in beliebiger Verpackung. */
function positionAddressesOf(raw: Record<string, unknown>): string[] {
  for (const key of ["position_addresses", "positions", "position_pubkeys", "positionAddresses"]) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    const addresses = value.flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (isRecord(entry)) {
        const nested = pickString([entry], ["address", "position_address", "pubkey"]);
        return nested === undefined ? [] : [nested];
      }
      return [];
    });
    if (addresses.length > 0) return addresses;
  }
  return [];
}

/**
 * Eine reale Position aus einer PnL-Antwort.
 *
 * `null`, wenn weder Adresse noch Zeitraum lesbar sind — ohne beides lässt sich
 * kein Replay derselben Zeitspanne bauen, und ein Datensatz, den man nicht
 * vergleichen kann, gehört nicht in die Kalibrierung.
 *
 * Die SOL-Beträge werden **nur** aus SOL-denominierten Feldern gelesen, nie aus
 * USD umgerechnet: Der SOL-Kurs zum Zeitpunkt der Position ist hier nicht
 * bekannt, und mit dem heutigen umzurechnen verschöbe jede ältere Messung.
 */
export function normalizeRealPosition(
  raw: unknown,
  poolAddress: string,
): RealPosition | null {
  if (!isRecord(raw)) return null;
  const scopes = scopesOf(raw);

  const positionAddress = pickString(scopes, [
    "position_address",
    "address",
    "position",
    "pubkey",
  ]);
  const openedAt = positionTimestamp(scopes, ["opened_at", "open_time", "created_at", "start_time"]);
  const closedAt = positionTimestamp(scopes, ["closed_at", "close_time", "end_time"]);
  if (positionAddress === undefined || openedAt === null) return null;

  const rawStatus = pickString(scopes, ["status", "state"])?.toLowerCase();
  const status: RealPosition["status"] =
    rawStatus === "closed" || (rawStatus === undefined && closedAt !== null) ? "closed" : "open";

  return {
    positionAddress,
    poolAddress: pickString(scopes, ["pool_address", "lb_pair", "lbPair"]) ?? poolAddress,
    status,
    openedAt,
    closedAt,
    depositSol: nullableNumber(
      pickNumber(scopes, ["total_deposit_sol", "deposits_sol", "deposit_sol", "total_deposits_sol"]),
    ),
    feesSol: nullableNumber(
      pickNumber(scopes, ["total_fees_sol", "fees_sol", "fee_earned_sol", "claimed_fee_sol"]),
    ),
    pnlSol: nullableNumber(pickNumber(scopes, ["pnl_sol", "total_pnl_sol", "net_pnl_sol"])),
    ...(pickInt(scopes, ["lower_bin_id", "min_bin_id", "lowerBinId"]) !== undefined
      ? { minBinId: pickInt(scopes, ["lower_bin_id", "min_bin_id", "lowerBinId"])! }
      : {}),
    ...(pickInt(scopes, ["upper_bin_id", "max_bin_id", "upperBinId"]) !== undefined
      ? { maxBinId: pickInt(scopes, ["upper_bin_id", "max_bin_id", "upperBinId"])! }
      : {}),
  };
}

/** Ganzzahl aus einem der Container — Bin-IDs dürfen negativ sein. */
function pickInt(scopes: Record<string, unknown>[], keys: string[]): number | undefined {
  const value = pickNumber(scopes, keys);
  return value === undefined || !Number.isFinite(value) ? undefined : Math.round(value);
}

/** Zeitstempel einer Position: Epoch-Sekunden oder ISO-Text. */
function positionTimestamp(
  scopes: Record<string, unknown>[],
  keys: string[],
): Date | null {
  const numeric = pickNumber(scopes, keys);
  if (numeric !== undefined && numeric > 0) return fromEpoch(numeric);

  const text = pickString(scopes, keys);
  if (text !== undefined) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
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

  // Kennzahlen über alle von der API gelieferten Fenster, nicht nur 24 h:
  // die kurzen Fenster tragen den Trend, den die Optimierung braucht.
  const volumeUsd = pickWindows(scopes, ["volume", "volume_usd"], {
    h24: ["trade_volume_24h", "volume_24h", "volume24h"],
  });
  const feesUsd = pickWindows(scopes, ["fees", "fees_usd"], {
    h24: ["fees_24h", "fee_24h", "fees24h"],
  });
  const protocolFeesUsd = pickWindows(scopes, ["protocol_fees"], {});
  const feeTvlPct = pickWindows(scopes, ["fee_tvl_ratio"], {
    h24: ["fee_tvl_ratio_24h"],
  });

  const volume24hUsd = volumeUsd.h24;
  const fees24hUsd = feesUsd.h24;

  // Fehlt das Verhältnis für ein Fenster, aber Gebühren und TVL liegen vor,
  // wird es gerechnet — die API liefert es nicht für jedes Fenster.
  if (tvlUsd !== undefined && tvlUsd > 0) {
    for (const window of METRIC_WINDOWS) {
      if (feeTvlPct[window] !== undefined) continue;
      const fees = feesUsd[window];
      if (fees !== undefined) feeTvlPct[window] = (fees / tvlUsd) * 100;
    }
  }
  const feeTvl24hPct = feeTvlPct.h24;

  const name = pickString(scopes, ["name", "pair_name", "symbol"]);
  const dynamicFeePct = pickNumber(scopes, ["dynamic_fee_pct", "current_fee_pct"]);
  const baseFeePct =
    pickNumber(scopes, ["base_fee_pct", "base_fee_percentage", "base_fee"]) ??
    // Fällt die Basisgebühr aus, ist die aktuelle dynamische Gebühr die beste
    // verfügbare Näherung für die Ertragskraft des Pools.
    dynamicFeePct;
  const maxFeePct = pickNumber(scopes, ["max_fee_pct", "max_fee_percentage", "max_fee"]);
  const protocolFeePct = pickNumber(scopes, [
    "protocol_fee_pct",
    "protocol_fee_percentage",
    "protocol_share_pct",
  ]);
  const collectFeeMode = pickCollectFeeMode(scopes);
  const priceNative = pickNumber(scopes, ["current_price", "price", "price_native"]);
  const apr = pickNumber(scopes, ["apr", "apr_24h"]);
  const apy = pickNumber(scopes, ["apy", "apy_24h"]);
  const hasFarm = pickBoolean(scopes, ["has_farm"]);
  const farmApr = pickNumber(scopes, ["farm_apr"]);
  const farmApy = pickNumber(scopes, ["farm_apy"]);
  const launchpad = pickString(scopes, ["launchpad"]);
  const poolCreatedAt = pickDate(scopes, ["created_at", "pool_created_at"]);
  const tokenX = pickTokenInfo(raw, ["token_x", "tokenX"], mintX);
  const tokenY = pickTokenInfo(raw, ["token_y", "tokenY"], mintY);

  return {
    poolAddress,
    mintX,
    mintY,
    binStep,
    volumeUsd,
    feesUsd,
    feeTvlPct,
    protocolFeesUsd,
    rewardMints: pickRewardMints(scopes),
    tags: pickStringArray(scopes, ["tags"]),
    fetchedAt: new Date(),
    source: "meteora",
    ...(name !== undefined ? { name } : {}),
    ...(baseFeePct !== undefined ? { baseFeePct } : {}),
    ...(maxFeePct !== undefined ? { maxFeePct } : {}),
    ...(dynamicFeePct !== undefined ? { dynamicFeePct } : {}),
    ...(protocolFeePct !== undefined ? { protocolFeePct } : {}),
    ...(collectFeeMode !== undefined ? { collectFeeMode } : {}),
    ...(tvlUsd !== undefined ? { tvlUsd } : {}),
    ...(volume24hUsd !== undefined ? { volume24hUsd } : {}),
    ...(fees24hUsd !== undefined ? { fees24hUsd } : {}),
    ...(feeTvl24hPct !== undefined ? { feeTvl24hPct } : {}),
    ...(priceNative !== undefined ? { priceNative } : {}),
    ...(apr !== undefined ? { apr } : {}),
    ...(apy !== undefined ? { apy } : {}),
    ...(hasFarm !== undefined ? { hasFarm } : {}),
    ...(farmApr !== undefined ? { farmApr } : {}),
    ...(farmApy !== undefined ? { farmApy } : {}),
    ...(launchpad !== undefined ? { launchpad } : {}),
    ...(poolCreatedAt !== undefined ? { poolCreatedAt } : {}),
    ...(tokenX !== undefined ? { tokenX } : {}),
    ...(tokenY !== undefined ? { tokenY } : {}),
  };
}

/**
 * Kennzahlen liegen je nach Schnittstelle flach (`volume_24h: 1234`) oder als
 * Objekt mit Zeitfenstern (`volume: { "1h": …, "24h": … }`). Die dokumentierte
 * datapi-Form nutzt `"30m"`/`"1h"`/…; ältere Antworten `hour_1`/`hour_24`.
 * Deshalb je Fenster eine Alias-Liste statt eines festen Schlüssels.
 */
const WINDOW_KEYS: Record<MetricWindow, string[]> = {
  m30: ["30m", "min_30", "minute_30", "m30", "last_30m"],
  h1: ["1h", "hour_1", "h1", "hour1", "last_1h", "min_60"],
  h2: ["2h", "hour_2", "h2", "hour2", "last_2h"],
  h4: ["4h", "hour_4", "h4", "hour4", "last_4h"],
  h12: ["12h", "hour_12", "h12", "hour12", "last_12h"],
  h24: ["24h", "hour_24", "h24", "hour24", "last_24h", "day_1", "d1", "min_1440"],
};

const WINDOW_24H_KEYS = WINDOW_KEYS.h24;

/** Platzhalter, mit denen Meteora "kein Reward-Token" ausdrückt. */
const EMPTY_MINTS = new Set([
  "11111111111111111111111111111111",
  "",
]);

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

/**
 * Liest eine Kennzahl über alle Zeitfenster.
 *
 * `containerKeys` sind die Objekte mit Fenster-Unterschlüsseln
 * (`volume: { "1h": … }`), `flatKeys` einzelne flache Felder je Fenster
 * (`trade_volume_24h`) für die ältere Schnittstelle.
 */
function pickWindows(
  scopes: Record<string, unknown>[],
  containerKeys: string[],
  flatKeys: Partial<Record<MetricWindow, string[]>>,
): WindowedMetric {
  const result: WindowedMetric = {};
  for (const window of METRIC_WINDOWS) {
    let value: number | undefined;
    for (const containerKey of containerKeys) {
      for (const scope of scopes) {
        const container = scope[containerKey];
        if (!isRecord(container)) continue;
        for (const alias of WINDOW_KEYS[window]) {
          const candidate = toNumber(container[alias]);
          if (candidate !== undefined) {
            value = candidate;
            break;
          }
        }
        if (value !== undefined) break;
      }
      if (value !== undefined) break;
    }
    // Flache Felder erst als Rückfallebene: das Fenster-Objekt ist genauer.
    value ??= pickFlat(scopes, flatKeys[window] ?? []);
    if (value !== undefined) result[window] = value;
  }
  return result;
}

/** Zahl aus flachen Feldern, ohne Fenster-Objekte zu berücksichtigen. */
function pickFlat(scopes: Record<string, unknown>[], keys: string[]): number | undefined {
  for (const key of keys) {
    for (const scope of scopes) {
      const value = toNumber(scope[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function pickBoolean(scopes: Record<string, unknown>[], keys: string[]): boolean | undefined {
  for (const key of keys) {
    for (const scope of scopes) {
      const value = scope[key];
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
    }
  }
  return undefined;
}

/**
 * Zeitstempel als ISO-String oder Unix-Zeit. Die OpenAPI-Spezifikation nennt
 * `created_at` als Integer, ältere Antworten liefern ISO-Strings — beides wird
 * akzeptiert. Sekunden und Millisekunden werden an der Größe unterschieden.
 */
function pickDate(scopes: Record<string, unknown>[], keys: string[]): Date | undefined {
  for (const key of keys) {
    for (const scope of scopes) {
      const value = scope[key];
      if (typeof value === "string" && value.trim() !== "") {
        const asNumber = Number(value);
        const parsed = Number.isFinite(asNumber)
          ? fromEpoch(asNumber)
          : new Date(value);
        if (!Number.isNaN(parsed.getTime())) return parsed;
      }
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return fromEpoch(value);
      }
    }
  }
  return undefined;
}

/** Unterscheidet Sekunden von Millisekunden: 1e12 liegt im Jahr 2001 ff. */
function fromEpoch(value: number): Date {
  return new Date(value < 1e12 ? value * 1000 : value);
}

/**
 * Zeitstempel einer Historien-Zeile. `timestamp` ist Unix-Sekunden; die Doku
 * nennt zusätzlich `timestamp_str`, der hier als Rückfallebene dient.
 * `null` heißt: Zeile ohne verwertbaren Zeitpunkt und damit unbrauchbar.
 */
function historyTimestamp(raw: Record<string, unknown>): Date | null {
  const numeric = toNumber(raw["timestamp"]);
  if (numeric !== undefined && numeric > 0) return fromEpoch(numeric);

  const text = raw["timestamp_str"];
  if (typeof text === "string" && text.trim() !== "") {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

/** Zahl oder `null` — für Historien-Felder, die fehlen dürfen. */
function nullableNumber(value: unknown): number | null {
  return toNumber(value) ?? null;
}

/** `collect_fee_mode`: 0 = Input-Token, 1 = immer Token Y. */
function pickCollectFeeMode(
  scopes: Record<string, unknown>[],
): CollectFeeMode | undefined {
  for (const key of ["collect_fee_mode", "collectFeeMode"]) {
    for (const scope of scopes) {
      const value = scope[key];
      const asNumber = toNumber(value);
      if (asNumber === 0) return "input_only";
      if (asNumber === 1) return "only_y";
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "inputonly" || normalized === "input_only") return "input_only";
        if (normalized === "onlyy" || normalized === "only_y") return "only_y";
      }
    }
  }
  return undefined;
}

function pickStringArray(scopes: Record<string, unknown>[], keys: string[]): string[] {
  for (const key of keys) {
    for (const scope of scopes) {
      const value = scope[key];
      if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === "string");
      }
    }
  }
  return [];
}

function pickRewardMints(scopes: Record<string, unknown>[]): string[] {
  const mints: string[] = [];
  for (const key of ["reward_mint_x", "reward_mint_y", "rewardMintX", "rewardMintY"]) {
    const value = pickString(scopes, [key]);
    if (value !== undefined && !EMPTY_MINTS.has(value) && !mints.includes(value)) {
      mints.push(value);
    }
  }
  return mints;
}

/**
 * Token-Angaben, die die Pool-API bereits mitliefert. Besonders
 * `freeze_authority_disabled` und `holders` ersparen dem Screening einen
 * eigenen Abruf — bislang wurden beide ausschließlich über RugCheck geholt und
 * bei fehlender Antwort fail-closed verworfen.
 */
function pickTokenInfo(
  raw: Record<string, unknown>,
  keys: string[],
  mint: string,
): PoolTokenInfo | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (!isRecord(value)) continue;
    const scopes = [value];
    const symbol = pickString(scopes, ["symbol"]);
    const name = pickString(scopes, ["name"]);
    const decimals = pickNumber(scopes, ["decimals"]);
    const holders = pickNumber(scopes, ["holders", "holder_count"]);
    const isVerified = pickBoolean(scopes, ["is_verified", "verified"]);
    const freezeAuthorityDisabled = pickBoolean(scopes, [
      "freeze_authority_disabled",
      "freezeAuthorityDisabled",
    ]);
    const priceUsd = pickNumber(scopes, ["price", "price_usd"]);
    const marketCapUsd = pickNumber(scopes, ["market_cap", "market_cap_usd"]);
    const totalSupply = pickNumber(scopes, ["total_supply"]);
    return {
      mint,
      ...(symbol !== undefined ? { symbol } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(decimals !== undefined ? { decimals } : {}),
      ...(holders !== undefined ? { holders } : {}),
      ...(isVerified !== undefined ? { isVerified } : {}),
      ...(freezeAuthorityDisabled !== undefined ? { freezeAuthorityDisabled } : {}),
      ...(priceUsd !== undefined ? { priceUsd } : {}),
      ...(marketCapUsd !== undefined ? { marketCapUsd } : {}),
      ...(totalSupply !== undefined ? { totalSupply } : {}),
    };
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
