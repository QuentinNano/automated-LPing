import { z } from "zod";
import type { AdapterHealth, MarketPairSnapshot } from "@lping/core";
import { AdapterError, TokenBucket, fetchJson, type FetchLike } from "./http";
import { WSOL_MINT } from "./constants";

const TxnWindowSchema = z
  .object({ buys: z.coerce.number().default(0), sells: z.coerce.number().default(0) })
  .partial();

const DexPairSchema = z
  .object({
    chainId: z.string().optional(),
    dexId: z.string().optional(),
    pairAddress: z.string(),
    baseToken: z
      .object({ address: z.string(), name: z.string().optional(), symbol: z.string().optional() })
      .passthrough(),
    quoteToken: z
      .object({ address: z.string(), name: z.string().optional(), symbol: z.string().optional() })
      .passthrough(),
    priceNative: z.coerce.number().optional(),
    priceUsd: z.coerce.number().optional(),
    txns: z
      .object({ m5: TxnWindowSchema, h1: TxnWindowSchema, h6: TxnWindowSchema, h24: TxnWindowSchema })
      .partial()
      .optional(),
    volume: z
      .object({
        m5: z.coerce.number().optional(),
        h1: z.coerce.number().optional(),
        h6: z.coerce.number().optional(),
        h24: z.coerce.number().optional(),
      })
      .partial()
      .optional(),
    liquidity: z
      .object({ usd: z.coerce.number().optional() })
      .partial()
      .passthrough()
      .optional(),
    priceChange: z
      .object({
        m5: z.coerce.number().optional(),
        h1: z.coerce.number().optional(),
        h6: z.coerce.number().optional(),
        h24: z.coerce.number().optional(),
      })
      .partial()
      .optional(),
    fdv: z.coerce.number().optional(),
    marketCap: z.coerce.number().optional(),
    /** Epoch-Millisekunden. */
    pairCreatedAt: z.coerce.number().optional(),
  })
  .passthrough();

export type DexPairRaw = z.infer<typeof DexPairSchema>;

export interface DexScreenerAdapterOptions {
  baseUrl?: string;
  limiter?: TokenBucket;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** DexScreener: quellenunabhängiger Markt-Querschnitt (Preis, Volumen, Trades, Pair-Alter). */
export class DexScreenerAdapter {
  private readonly baseUrl: string;
  private readonly limiter: TokenBucket;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: DexScreenerAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.dexscreener.com").replace(/\/$/, "");
    // Öffentliches Limit ~300 req/min → konservativ 4/s.
    this.limiter = options.limiter ?? new TokenBucket(4);
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
  }

  /** Alle bekannten Handelspaare eines Tokens auf Solana. */
  async getPairsForToken(mint: string): Promise<{ pairs: MarketPairSnapshot[]; skipped: number }> {
    const url = `${this.baseUrl}/token-pairs/v1/solana/${mint}`;
    const payload = await fetchJson(url, {
      schema: z.unknown(),
      limiter: this.limiter,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });

    const items = Array.isArray(payload)
      ? payload
      : typeof payload === "object" && payload !== null && Array.isArray((payload as Record<string, unknown>)["pairs"])
        ? ((payload as Record<string, unknown>)["pairs"] as unknown[])
        : null;
    if (items === null) {
      throw new AdapterError("Unerwartete Envelope-Form der Pair-Liste", "validation", { url });
    }

    const pairs: MarketPairSnapshot[] = [];
    let skipped = 0;
    for (const item of items) {
      const parsed = DexPairSchema.safeParse(item);
      if (parsed.success) pairs.push(normalizeDexPair(parsed.data));
      else skipped++;
    }
    return { pairs, skipped };
  }

  async health(): Promise<AdapterHealth> {
    const started = Date.now();
    try {
      await this.getPairsForToken(WSOL_MINT);
      return { adapter: "dexscreener", ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        adapter: "dexscreener",
        ok: false,
        latencyMs: Date.now() - started,
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function normalizeDexPair(raw: DexPairRaw): MarketPairSnapshot {
  const txns: MarketPairSnapshot["txns"] = {};
  for (const window of ["m5", "h1", "h6", "h24"] as const) {
    const entry = raw.txns?.[window];
    if (entry !== undefined) {
      txns[window] = { buys: entry.buys ?? 0, sells: entry.sells ?? 0 };
    }
  }

  const volume: MarketPairSnapshot["volume"] = {};
  for (const window of ["m5", "h1", "h6", "h24"] as const) {
    const value = raw.volume?.[window];
    if (value !== undefined) volume[window] = value;
  }

  const priceChange: NonNullable<MarketPairSnapshot["priceChange"]> = {};
  let hasPriceChange = false;
  for (const window of ["m5", "h1", "h6", "h24"] as const) {
    const value = raw.priceChange?.[window];
    if (value !== undefined) {
      priceChange[window] = value;
      hasPriceChange = true;
    }
  }

  return {
    pairAddress: raw.pairAddress,
    baseToken: {
      mint: raw.baseToken.address,
      ...(raw.baseToken.symbol !== undefined ? { symbol: raw.baseToken.symbol } : {}),
    },
    quoteToken: {
      mint: raw.quoteToken.address,
      ...(raw.quoteToken.symbol !== undefined ? { symbol: raw.quoteToken.symbol } : {}),
    },
    volume,
    txns,
    fetchedAt: new Date(),
    source: "dexscreener",
    ...(raw.dexId !== undefined ? { dexId: raw.dexId } : {}),
    ...(raw.priceUsd !== undefined ? { priceUsd: raw.priceUsd } : {}),
    ...(raw.priceNative !== undefined ? { priceNative: raw.priceNative } : {}),
    ...(raw.liquidity?.usd !== undefined ? { liquidityUsd: raw.liquidity.usd } : {}),
    ...(hasPriceChange ? { priceChange } : {}),
    ...(raw.fdv !== undefined ? { fdvUsd: raw.fdv } : {}),
    ...(raw.marketCap !== undefined ? { marketCapUsd: raw.marketCap } : {}),
    ...(raw.pairCreatedAt !== undefined ? { pairCreatedAt: new Date(raw.pairCreatedAt) } : {}),
  };
}
