import { z } from "zod";
import type { AdapterHealth, FabriqPool, FabriqTrendingResult } from "@lping/core";
import { TokenBucket, fetchJson, type FetchLike } from "../http";

/**
 * SPIKE-Adapter für Fabriq (siehe SPIKE.md in diesem Ordner).
 *
 * Fabriq hat keine dokumentierte öffentliche API. Dieser Adapter ist deshalb
 * bewusst defensiv gebaut:
 * - Endpoint (Basis-URL + Pfad) ist konfigurierbar (env/Optionen), bis der
 *   echte interne Endpoint per DevTools-Analyse verifiziert ist.
 * - Die Antwort wird als `unknown` geladen; Pools werden heuristisch
 *   extrahiert (Base58-Adressfelder + Score-Felder in beliebiger Nesting-Tiefe).
 * - `getTrending` wirft NIE: Fehler werden als Status (`unavailable`,
 *   `schema_drift`) gemeldet, damit die Discovery automatisch auf die eigene
 *   Preset-Replikation zurückfallen kann (KONZEPT.md Abschnitt 4.1).
 * - Rate-Limit: max. 1 Request / 30 s (Rücksichtnahme + Blockvermeidung).
 */

export interface FabriqAdapterOptions {
  baseUrl?: string;
  trendingPath?: string;
  limiter?: TokenBucket;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADDRESS_KEYS = [
  "address",
  "poolAddress",
  "pool_address",
  "pairAddress",
  "pair_address",
  "lbPair",
  "lb_pair",
  "pool",
];
const SCORE_KEYS = ["score", "fabriqScore", "fabriq_score", "trendingScore", "trending_score"];
const NAME_KEYS = ["name", "pairName", "pair_name", "symbol", "tokenName"];

export class FabriqAdapter {
  private readonly baseUrl: string;
  private readonly trendingPath: string;
  private readonly limiter: TokenBucket;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: FabriqAdapterOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      process.env["FABRIQ_API_BASE"] ??
      "https://fabriq.trade"
    ).replace(/\/$/, "");
    // Platzhalter-Pfad bis zur Endpoint-Verifikation (SPIKE.md).
    this.trendingPath = options.trendingPath ?? process.env["FABRIQ_TRENDING_PATH"] ?? "/api/trending";
    this.limiter = options.limiter ?? new TokenBucket(1 / 30, 1);
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
  }

  async getTrending(category: "degen" | "multiday"): Promise<FabriqTrendingResult> {
    let payload: unknown;
    try {
      payload = await fetchJson(`${this.baseUrl}${this.trendingPath}`, {
        schema: z.unknown(),
        searchParams: { category },
        limiter: this.limiter,
        retries: 1,
        headers: { "user-agent": "automated-lping/0.1 (personal research bot)" },
        ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      });
    } catch (error) {
      return {
        status: "unavailable",
        category,
        pools: [],
        note: error instanceof Error ? error.message : String(error),
      };
    }

    const pools = extractFabriqPools(payload);
    if (pools.length === 0) {
      return {
        status: "schema_drift",
        category,
        pools: [],
        note: "Antwort erreichbar, aber keine Pool-Objekte erkannt — Endpoint/Parser prüfen (SPIKE.md)",
      };
    }
    return { status: "ok", category, pools };
  }

  async health(): Promise<AdapterHealth> {
    const started = Date.now();
    const result = await this.getTrending("degen");
    return {
      adapter: "fabriq",
      ok: result.status === "ok",
      latencyMs: Date.now() - started,
      ...(result.note !== undefined ? { note: result.note } : { note: `status=${result.status}` }),
    };
  }
}

/**
 * Heuristische Pool-Extraktion aus einer unbekannten JSON-Struktur:
 * findet Objekte mit Base58-Adressfeld in Arrays beliebiger Tiefe (<= 6).
 * Exportiert für Tests und für die spätere Endpoint-Verifikation.
 */
export function extractFabriqPools(payload: unknown, maxDepth = 6): FabriqPool[] {
  const found = new Map<string, FabriqPool>();
  walk(payload, 0);
  return [...found.values()];

  function walk(node: unknown, depth: number): void {
    if (depth > maxDepth || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) {
        const pool = tryExtractPool(item);
        if (pool !== null) found.set(pool.poolAddress, pool);
        walk(item, depth + 1);
      }
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      walk(value, depth + 1);
    }
  }
}

function tryExtractPool(item: unknown): FabriqPool | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as Record<string, unknown>;

  let address: string | null = null;
  for (const key of ADDRESS_KEYS) {
    const value = record[key];
    if (typeof value === "string" && BASE58_RE.test(value)) {
      address = value;
      break;
    }
  }
  if (address === null) return null;

  let score: number | undefined;
  for (const key of SCORE_KEYS) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      score = value;
      break;
    }
  }

  let name: string | undefined;
  for (const key of NAME_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      name = value;
      break;
    }
  }

  return {
    poolAddress: address,
    raw: item,
    ...(score !== undefined ? { score } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}
