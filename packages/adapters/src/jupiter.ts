import { z } from "zod";
import type { AdapterHealth, SellabilityCheck, SwapQuote } from "@lping/core";
import { AdapterError, TokenBucket, fetchJson, type FetchLike } from "./http";
import { LAMPORTS_PER_SOL, USDC_MINT, WSOL_MINT } from "./constants";

const QuoteSchema = z
  .object({
    inputMint: z.string(),
    inAmount: z.string(),
    outputMint: z.string(),
    outAmount: z.string(),
    priceImpactPct: z.coerce.number().optional(),
    routePlan: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type JupiterQuoteRaw = z.infer<typeof QuoteSchema>;

export interface JupiterAdapterOptions {
  baseUrl?: string;
  limiter?: TokenBucket;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  /** Betrag in Basiseinheiten des Input-Mints. */
  amountRaw: string;
  slippageBps?: number;
}

export interface SellabilityOptions {
  /** Probe-Größe des hypothetischen Kaufs (Default 0,1 SOL). */
  probeSolLamports?: number;
  /** Ab diesem Preis-Impact/Roundtrip-Verlust gilt der Token als illiquide. */
  maxImpactPct?: number;
}

/**
 * Jupiter-Quote-API: Referenzpreise, Ausführbarkeits-Checks und (später)
 * Swap-Routen. Der Verkaufbarkeits-Check quotet beide Richtungen und ist
 * der zentrale Honeypot-Filter (KONZEPT.md Abschnitt 5.1).
 */
export class JupiterAdapter {
  private readonly baseUrl: string;
  private readonly limiter: TokenBucket;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: JupiterAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");
    this.limiter = options.limiter ?? new TokenBucket(2);
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
  }

  async getQuote(params: QuoteParams): Promise<SwapQuote> {
    const raw = await fetchJson(`${this.baseUrl}/quote`, {
      schema: QuoteSchema,
      searchParams: {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amountRaw,
        slippageBps: params.slippageBps ?? 100,
        restrictIntermediateTokens: true,
      },
      limiter: this.limiter,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });

    return {
      inputMint: raw.inputMint,
      outputMint: raw.outputMint,
      inAmountRaw: raw.inAmount,
      outAmountRaw: raw.outAmount,
      priceImpactPct: raw.priceImpactPct ?? null,
      routeHops: raw.routePlan?.length ?? 0,
      fetchedAt: new Date(),
      source: "jupiter",
    };
  }

  /**
   * Honeypot-/Liquiditätscheck: SOL→Token und Token→SOL quoten.
   * Ein 4xx ("keine Route") gilt als blockiert; Netzwerk-/Serverfehler
   * werden dagegen weitergereicht — "API kaputt" ist kein Urteil über den Token.
   */
  async checkSellability(mint: string, options: SellabilityOptions = {}): Promise<SellabilityCheck> {
    const probe = options.probeSolLamports ?? LAMPORTS_PER_SOL / 10;
    const maxImpactPct = options.maxImpactPct ?? 25;
    const checkedAt = new Date();

    let buy: SwapQuote;
    try {
      buy = await this.getQuote({ inputMint: WSOL_MINT, outputMint: mint, amountRaw: String(probe) });
    } catch (error) {
      if (isNoRouteError(error)) {
        return {
          mint,
          buyOk: false,
          sellOk: false,
          buyImpactPct: null,
          sellImpactPct: null,
          roundTripLossPct: null,
          verdict: "blocked",
          checkedAt,
        };
      }
      throw error;
    }

    let sell: SwapQuote;
    try {
      sell = await this.getQuote({ inputMint: mint, outputMint: WSOL_MINT, amountRaw: buy.outAmountRaw });
    } catch (error) {
      if (isNoRouteError(error)) {
        return {
          mint,
          buyOk: true,
          sellOk: false,
          buyImpactPct: buy.priceImpactPct,
          sellImpactPct: null,
          roundTripLossPct: null,
          verdict: "blocked",
          checkedAt,
        };
      }
      throw error;
    }

    const returned = Number(sell.outAmountRaw);
    const roundTripLossPct = Number.isFinite(returned) ? ((probe - returned) / probe) * 100 : null;
    const worstImpact = Math.max(buy.priceImpactPct ?? 0, sell.priceImpactPct ?? 0);
    const illiquid =
      worstImpact > maxImpactPct || (roundTripLossPct !== null && roundTripLossPct > maxImpactPct);

    return {
      mint,
      buyOk: true,
      sellOk: true,
      buyImpactPct: buy.priceImpactPct,
      sellImpactPct: sell.priceImpactPct,
      roundTripLossPct,
      verdict: illiquid ? "illiquid" : "sellable",
      checkedAt,
    };
  }

  async health(): Promise<AdapterHealth> {
    const started = Date.now();
    try {
      await this.getQuote({
        inputMint: WSOL_MINT,
        outputMint: USDC_MINT,
        amountRaw: String(LAMPORTS_PER_SOL / 1000),
      });
      return { adapter: "jupiter", ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        adapter: "jupiter",
        ok: false,
        latencyMs: Date.now() - started,
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function isNoRouteError(error: unknown): boolean {
  return (
    error instanceof AdapterError &&
    error.kind === "http" &&
    error.meta.status !== undefined &&
    error.meta.status >= 400 &&
    error.meta.status < 500 &&
    error.meta.status !== 429
  );
}
