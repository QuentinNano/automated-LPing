import { z } from "zod";
import type { AdapterHealth, PoolMetrics } from "@lping/core";
import { AdapterError, TokenBucket, fetchJson, type FetchLike } from "./http";

/**
 * Meteora-DLMM-Daten-API (öffentlich): Pool-Metriken für Discovery/Scoring.
 * Feldliste bewusst lenient (`passthrough` + optionale Felder): die API ist
 * nicht formal versioniert; unbekannte Zusatzfelder dürfen nie zum Ausfall führen.
 */
const MeteoraPairSchema = z
  .object({
    address: z.string().min(32),
    name: z.string().optional(),
    mint_x: z.string(),
    mint_y: z.string(),
    bin_step: z.coerce.number(),
    base_fee_percentage: z.coerce.number().optional(),
    max_fee_percentage: z.coerce.number().optional(),
    liquidity: z.coerce.number().optional(),
    current_price: z.coerce.number().optional(),
    trade_volume_24h: z.coerce.number().optional(),
    fees_24h: z.coerce.number().optional(),
    apr: z.coerce.number().optional(),
    apy: z.coerce.number().optional(),
  })
  .passthrough();

export type MeteoraPairRaw = z.infer<typeof MeteoraPairSchema>;

export interface MeteoraPairsPage {
  pairs: PoolMetrics[];
  total?: number;
  /** Anzahl Einträge, die die Einzel-Validierung nicht bestanden haben. */
  skipped: number;
}

export interface MeteoraAdapterOptions {
  baseUrl?: string;
  limiter?: TokenBucket;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export class MeteoraAdapter {
  private readonly baseUrl: string;
  private readonly limiter: TokenBucket;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: MeteoraAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://dlmm-api.meteora.ag").replace(/\/$/, "");
    this.limiter = options.limiter ?? new TokenBucket(2);
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
  }

  async getPair(address: string): Promise<PoolMetrics> {
    const raw = await fetchJson(`${this.baseUrl}/pair/${address}`, {
      schema: MeteoraPairSchema,
      limiter: this.limiter,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
    return normalizeMeteoraPair(raw);
  }

  /**
   * Paginierte Pool-Liste. Die Envelope-Form ist tolerant implementiert
   * (nacktes Array, `{pairs: []}` oder `{data: []}`), einzelne fehlerhafte
   * Einträge werden übersprungen und gezählt statt den Batch zu verwerfen.
   */
  async getPairsPage(params: { page?: number; limit?: number } = {}): Promise<MeteoraPairsPage> {
    const payload = await fetchJson(`${this.baseUrl}/pair/all_with_pagination`, {
      schema: z.unknown(),
      searchParams: { page: params.page ?? 0, limit: params.limit ?? 50 },
      limiter: this.limiter,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });

    const { items, total } = unwrapPairsEnvelope(payload, `${this.baseUrl}/pair/all_with_pagination`);
    const pairs: PoolMetrics[] = [];
    let skipped = 0;
    for (const item of items) {
      const parsed = MeteoraPairSchema.safeParse(item);
      if (parsed.success) pairs.push(normalizeMeteoraPair(parsed.data));
      else skipped++;
    }
    return { pairs, skipped, ...(total !== undefined ? { total } : {}) };
  }

  async health(): Promise<AdapterHealth> {
    const started = Date.now();
    try {
      await this.getPairsPage({ limit: 1 });
      return { adapter: "meteora", ok: true, latencyMs: Date.now() - started };
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

function unwrapPairsEnvelope(
  payload: unknown,
  url: string,
): { items: unknown[]; total?: number } {
  if (Array.isArray(payload)) return { items: payload };
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    for (const key of ["pairs", "data", "groups"]) {
      const value = record[key];
      if (Array.isArray(value)) {
        const total = typeof record["total"] === "number" ? record["total"] : undefined;
        return { items: value, ...(total !== undefined ? { total } : {}) };
      }
    }
  }
  throw new AdapterError("Unerwartete Envelope-Form der Pool-Liste", "validation", { url });
}

export function normalizeMeteoraPair(raw: MeteoraPairRaw): PoolMetrics {
  const tvlUsd = raw.liquidity;
  const fees24hUsd = raw.fees_24h;
  const feeTvl24hPct =
    tvlUsd !== undefined && tvlUsd > 0 && fees24hUsd !== undefined
      ? (fees24hUsd / tvlUsd) * 100
      : undefined;

  return {
    poolAddress: raw.address,
    mintX: raw.mint_x,
    mintY: raw.mint_y,
    binStep: raw.bin_step,
    fetchedAt: new Date(),
    source: "meteora",
    ...(raw.name !== undefined ? { name: raw.name } : {}),
    ...(raw.base_fee_percentage !== undefined ? { baseFeePct: raw.base_fee_percentage } : {}),
    ...(raw.max_fee_percentage !== undefined ? { maxFeePct: raw.max_fee_percentage } : {}),
    ...(tvlUsd !== undefined ? { tvlUsd } : {}),
    ...(raw.trade_volume_24h !== undefined ? { volume24hUsd: raw.trade_volume_24h } : {}),
    ...(fees24hUsd !== undefined ? { fees24hUsd } : {}),
    ...(feeTvl24hPct !== undefined ? { feeTvl24hPct } : {}),
    ...(raw.current_price !== undefined ? { priceNative: raw.current_price } : {}),
    ...(raw.apr !== undefined ? { apr: raw.apr } : {}),
    ...(raw.apy !== undefined ? { apy: raw.apy } : {}),
  };
}
