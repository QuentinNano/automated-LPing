import type { z } from "zod";

export type AdapterErrorKind = "network" | "timeout" | "http" | "parse" | "validation";

export interface AdapterErrorMeta {
  url: string;
  status?: number;
  bodySnippet?: string;
}

export class AdapterError extends Error {
  constructor(
    message: string,
    public readonly kind: AdapterErrorKind,
    public readonly meta: AdapterErrorMeta,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AdapterError";
  }
}

/** Einfacher Token-Bucket: ratePerSec Requests, Burst-Kapazität >= 1. */
export class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly ratePerSec: number,
    private readonly burst: number = Math.max(1, Math.ceil(ratePerSec)),
  ) {
    if (ratePerSec <= 0) throw new Error("ratePerSec muss > 0 sein");
    this.tokens = this.burst;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(
        this.burst,
        this.tokens + ((now - this.lastRefill) / 1000) * this.ratePerSec,
      );
      this.lastRefill = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(((1 - this.tokens) / this.ratePerSec) * 1000);
    }
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FetchJsonOptions<T> {
  schema: z.ZodType<T>;
  searchParams?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Default 10 s. */
  timeoutMs?: number;
  /** Anzahl Wiederholungen nach dem Erstversuch (Default 2). */
  retries?: number;
  /** Basis-Backoff; wächst exponentiell mit Jitter (Default 400 ms). */
  backoffMs?: number;
  limiter?: TokenBucket;
  /** Injektionspunkt für Tests. */
  fetchImpl?: FetchLike;
}

/**
 * JSON-GET mit Timeout, Rate-Limiting, Retries (Netzwerkfehler, 429, 5xx)
 * und zod-Validierung. 4xx (außer 429) sowie Parse-/Validierungsfehler werden
 * nicht wiederholt.
 */
export async function fetchJson<T>(url: string | URL, opts: FetchJsonOptions<T>): Promise<T> {
  const {
    schema,
    searchParams,
    headers,
    timeoutMs = 10_000,
    retries = 2,
    backoffMs = 400,
    limiter,
    fetchImpl = globalThis.fetch,
  } = opts;

  const target = new URL(url.toString());
  if (searchParams !== undefined) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) target.searchParams.set(key, String(value));
    }
  }
  const targetStr = target.toString();

  let lastError: AdapterError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const retryAfterMs = lastError?.kind === "http" ? retryAfterFrom(lastError) : null;
      await sleep(retryAfterMs ?? backoffMs * 2 ** (attempt - 1) + Math.random() * 100);
    }
    if (limiter !== undefined) await limiter.take();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(targetStr, {
        headers: { accept: "application/json", ...headers },
        signal: controller.signal,
      });
    } catch (cause) {
      const isAbort = cause instanceof Error && cause.name === "AbortError";
      lastError = new AdapterError(
        isAbort ? `Timeout nach ${timeoutMs} ms: ${targetStr}` : `Netzwerkfehler: ${targetStr}`,
        isAbort ? "timeout" : "network",
        { url: targetStr },
        { cause },
      );
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const bodySnippet = (await response.text().catch(() => "")).slice(0, 300);
      lastError = new AdapterError(
        `HTTP ${response.status} von ${targetStr}`,
        "http",
        {
          url: targetStr,
          status: response.status,
          bodySnippet,
          ...retryAfterMeta(response),
        } as AdapterErrorMeta,
      );
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < retries) continue;
      throw lastError;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (cause) {
      throw new AdapterError(
        `Antwort ist kein JSON: ${targetStr}`,
        "parse",
        { url: targetStr, status: response.status },
        { cause },
      );
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      throw new AdapterError(`Schema-Validierung fehlgeschlagen (${issues}): ${targetStr}`, "validation", {
        url: targetStr,
        status: response.status,
      });
    }
    return parsed.data;
  }

  throw lastError ?? new AdapterError(`Unbekannter Fehler: ${targetStr}`, "network", { url: targetStr });
}

interface RetryAfterMeta {
  retryAfterMs?: number;
}

function retryAfterMeta(response: Response): RetryAfterMeta {
  const header = response.headers.get("retry-after");
  if (header === null) return {};
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return {};
  return { retryAfterMs: Math.min(seconds, 10) * 1000 };
}

function retryAfterFrom(error: AdapterError): number | null {
  const value = (error.meta as AdapterErrorMeta & RetryAfterMeta).retryAfterMs;
  return typeof value === "number" ? value : null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
