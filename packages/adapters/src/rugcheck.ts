import { z } from "zod";
import type { AdapterHealth, TokenRiskReport } from "@lping/core";
import { TokenBucket, fetchJson, type FetchLike } from "./http";
import { WSOL_MINT } from "./constants";

const RiskSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    level: z.string().optional(),
    score: z.coerce.number().optional(),
  })
  .passthrough();

const HolderSchema = z
  .object({
    address: z.string().optional(),
    owner: z.string().optional(),
    pct: z.coerce.number().optional(),
    insider: z.boolean().optional(),
  })
  .passthrough();

const RugcheckReportSchema = z
  .object({
    mint: z.string().optional(),
    score: z.coerce.number().optional(),
    score_normalised: z.coerce.number().optional(),
    risks: z.array(RiskSchema).optional(),
    token: z
      .object({
        mintAuthority: z.string().nullable().optional(),
        freezeAuthority: z.string().nullable().optional(),
        supply: z.coerce.number().optional(),
        decimals: z.coerce.number().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    topHolders: z.array(HolderSchema).optional(),
    totalMarketLiquidity: z.coerce.number().optional(),
  })
  .passthrough();

export type RugcheckReportRaw = z.infer<typeof RugcheckReportSchema>;

const RugcheckSummarySchema = z
  .object({
    score: z.coerce.number().optional(),
    score_normalised: z.coerce.number().optional(),
    risks: z.array(RiskSchema).optional(),
  })
  .passthrough();

export interface RugcheckAdapterOptions {
  baseUrl?: string;
  limiter?: TokenBucket;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * RugCheck: Token-Risiko-Reports (Authorities, Holder-Verteilung, Insider,
 * Risiko-Flags). Liefert tri-state Aussagen — `null` heißt "nicht bekannt",
 * nie "unbedenklich". Das Screening behandelt fehlende Daten konservativ.
 */
export class RugcheckAdapter {
  private readonly baseUrl: string;
  private readonly limiter: TokenBucket;
  private readonly fetchImpl: FetchLike | undefined;
  private readonly timeoutMs: number | undefined;

  constructor(options: RugcheckAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "https://api.rugcheck.xyz/v1").replace(/\/$/, "");
    this.limiter = options.limiter ?? new TokenBucket(1);
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
  }

  async getReport(mint: string): Promise<TokenRiskReport> {
    const raw = await fetchJson(`${this.baseUrl}/tokens/${mint}/report`, {
      schema: RugcheckReportSchema,
      limiter: this.limiter,
      ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
    return normalizeRugcheckReport(mint, raw);
  }

  async health(): Promise<AdapterHealth> {
    const started = Date.now();
    try {
      await fetchJson(`${this.baseUrl}/tokens/${WSOL_MINT}/report/summary`, {
        schema: RugcheckSummarySchema,
        limiter: this.limiter,
        ...(this.fetchImpl !== undefined ? { fetchImpl: this.fetchImpl } : {}),
        ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
      });
      return { adapter: "rugcheck", ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        adapter: "rugcheck",
        ok: false,
        latencyMs: Date.now() - started,
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function normalizeRugcheckReport(mint: string, raw: RugcheckReportRaw): TokenRiskReport {
  const token = raw.token ?? null;

  const holders = (raw.topHolders ?? [])
    .filter((h) => typeof h.pct === "number")
    .map((h) => ({
      address: h.address ?? h.owner ?? "unknown",
      pct: h.pct as number,
      insider: h.insider ?? false,
    }));

  const top10HolderPct =
    holders.length > 0
      ? holders
          .slice()
          .sort((a, b) => b.pct - a.pct)
          .slice(0, 10)
          .reduce((sum, h) => sum + h.pct, 0)
      : null;

  const insiderPct =
    holders.length > 0 ? holders.filter((h) => h.insider).reduce((sum, h) => sum + h.pct, 0) : null;

  return {
    mint: raw.mint ?? mint,
    rawScore: raw.score ?? null,
    normalizedScore: raw.score_normalised ?? null,
    risks: (raw.risks ?? []).map((r) => ({
      name: r.name,
      ...(r.level !== undefined ? { level: r.level } : {}),
      ...(r.score !== undefined ? { score: r.score } : {}),
      ...(r.description !== undefined ? { description: r.description } : {}),
    })),
    // token === null/fehlt → Aussage nicht möglich (nie als "revoked" werten).
    mintAuthorityRevoked: token === null ? null : (token.mintAuthority ?? null) === null,
    freezeAuthorityRevoked: token === null ? null : (token.freezeAuthority ?? null) === null,
    topHolders: holders,
    top10HolderPct,
    insiderPct,
    totalMarketLiquidityUsd: raw.totalMarketLiquidity ?? null,
    fetchedAt: new Date(),
    source: "rugcheck",
  };
}
