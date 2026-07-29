import { z } from "zod";
import type { AdapterHealth, TokenOrganics } from "@lping/core";
import { AdapterError, TokenBucket, fetchJson, type FetchLike } from "./http";
import { WSOL_MINT } from "./constants";

/**
 * Jupiter Token API v2: Organic Score und Holder-Zahl.
 *
 * Der Organic Score (0–100) bewertet, wie *echt* die Aktivität eines Tokens ist —
 * die Frage, die unsere eigene Wash-Trading-Heuristik nur grob beantwortet. Er
 * ist ein fremdes Modell, dessen Berechnung wir nicht kennen: Er wird deshalb als
 * Merkmal geführt und für Schwellwerte genutzt, nie als alleiniges
 * Ausschlusskriterium (KONZEPT-ML.md Abschnitt 4.1).
 */

const TokenSchema = z
  .object({
    id: z.string().optional(),
    address: z.string().optional(),
    mint: z.string().optional(),
    symbol: z.string().optional(),
    name: z.string().optional(),
    decimals: z.coerce.number().optional(),
    holderCount: z.coerce.number().optional(),
    organicScore: z.coerce.number().optional(),
    organicScoreLabel: z.string().optional(),
    isVerified: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    audit: z
      .object({
        mintAuthorityDisabled: z.boolean().optional(),
        freezeAuthorityDisabled: z.boolean().optional(),
        topHoldersPercentage: z.coerce.number().optional(),
      })
      .passthrough()
      .optional(),
    fdv: z.coerce.number().optional(),
    mcap: z.coerce.number().optional(),
    liquidity: z.coerce.number().optional(),
  })
  .passthrough();

export interface JupiterTokenAdapterOptions {
  baseUrl?: string;
  limiter?: TokenBucket;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class JupiterTokenAdapter {
  private readonly baseUrl: string;
  private readonly limiter: TokenBucket;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: JupiterTokenAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://lite-api.jup.ag/tokens/v2").replace(/\/$/, "");
    this.limiter = options.limiter ?? new TokenBucket(2);
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
  }

  /**
   * Token-Kennzahlen zu einem Mint. Liefert `null`, wenn Jupiter den Token
   * nicht kennt — das ist eine Information (sehr neu oder sehr unbedeutend),
   * kein Fehler.
   */
  async getOrganics(mint: string): Promise<TokenOrganics | null> {
    const payload = await fetchJson(`${this.baseUrl}/search`, {
      schema: z.unknown(),
      searchParams: { query: mint },
      limiter: this.limiter,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });

    const items = unwrapTokens(payload, `${this.baseUrl}/search`);
    for (const item of items) {
      const parsed = TokenSchema.safeParse(item);
      if (!parsed.success) continue;
      const raw = parsed.data;
      const id = raw.id ?? raw.address ?? raw.mint;
      // Die Suche liefert auch Treffer über Symbol/Name — nur der exakte Mint zählt.
      if (id !== mint) continue;
      return normalizeOrganics(mint, raw);
    }
    return null;
  }

  async health(): Promise<AdapterHealth> {
    const started = Date.now();
    try {
      const organics = await this.getOrganics(WSOL_MINT);
      return {
        adapter: "jupiter-tokens",
        ok: organics !== null,
        latencyMs: Date.now() - started,
        ...(organics === null ? { note: "SOL nicht gefunden — Antwortformat prüfen" } : {}),
      };
    } catch (error) {
      return {
        adapter: "jupiter-tokens",
        ok: false,
        latencyMs: Date.now() - started,
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function unwrapTokens(payload: unknown, url: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    for (const key of ["tokens", "data", "results", "items"]) {
      const value = record[key];
      if (Array.isArray(value)) return value;
    }
    // Einzelnes Token-Objekt statt Liste.
    if (typeof record["id"] === "string" || typeof record["address"] === "string") return [record];
  }
  throw new AdapterError("Unerwartete Antwortform der Token-Suche", "validation", { url });
}

export function normalizeOrganics(
  mint: string,
  raw: z.infer<typeof TokenSchema>,
): TokenOrganics {
  const label = raw.organicScoreLabel?.toLowerCase();
  return {
    mint,
    organicScore: raw.organicScore ?? null,
    organicScoreLabel:
      label === "high" || label === "medium" || label === "low" ? label : null,
    holderCount: raw.holderCount ?? null,
    isVerified: raw.isVerified ?? null,
    // Jupiter prüft die Autoritäten selbst — als unabhängige Gegenprobe zu RugCheck.
    mintAuthorityDisabled: raw.audit?.mintAuthorityDisabled ?? null,
    freezeAuthorityDisabled: raw.audit?.freezeAuthorityDisabled ?? null,
    topHoldersPct: raw.audit?.topHoldersPercentage ?? null,
    fdvUsd: raw.fdv ?? null,
    liquidityUsd: raw.liquidity ?? null,
    tags: raw.tags ?? [],
    fetchedAt: new Date(),
    source: "jupiter-tokens",
  };
}
