import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MeteoraAdapter, TokenBucket } from "@lping/adapters";
import { fetchQueue, jsonResponse } from "./helpers";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const pairFixture = JSON.parse(readFileSync(path.join(fixturesDir, "meteora-pair.json"), "utf8"));

const fastLimiter = () => new TokenBucket(1000);

describe("MeteoraAdapter", () => {
  it("normalisiert einen Pool inkl. abgeleiteter Fee/TVL-Rate", async () => {
    const { fetchImpl } = fetchQueue([jsonResponse(pairFixture)]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    const pool = await adapter.getPair(pairFixture.address);

    expect(pool.poolAddress).toBe(pairFixture.address);
    expect(pool.mintY).toBe("So11111111111111111111111111111111111111112");
    expect(pool.binStep).toBe(100);
    expect(pool.baseFeePct).toBe(1);
    expect(pool.tvlUsd).toBeCloseTo(250000.42);
    expect(pool.volume24hUsd).toBeCloseTo(1250000.75);
    // 12500.5 / 250000.42 * 100 ≈ 5.0
    expect(pool.feeTvl24hPct).toBeCloseTo(5.0, 1);
    expect(pool.source).toBe("meteora");
  });

  it("akzeptiert Seiten-Envelope {pairs: []} und überspringt kaputte Einträge", async () => {
    const { fetchImpl, calls } = fetchQueue([
      jsonResponse({ pairs: [pairFixture, { garbage: true }], total: 2 }),
    ]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    const page = await adapter.getPairsPage({ page: 0, limit: 50 });

    expect(page.pairs).toHaveLength(1);
    expect(page.skipped).toBe(1);
    expect(page.total).toBe(2);
    expect(calls[0]).toContain("/pair/all_with_pagination?page=0&limit=50");
  });

  it("akzeptiert auch ein nacktes Array als Envelope", async () => {
    const { fetchImpl } = fetchQueue([jsonResponse([pairFixture])]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });
    const page = await adapter.getPairsPage();
    expect(page.pairs).toHaveLength(1);
    expect(page.skipped).toBe(0);
  });

  it("meldet eine unbekannte Envelope-Form als Validierungsfehler", async () => {
    const { fetchImpl } = fetchQueue([jsonResponse({ foo: "bar" })]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });
    await expect(adapter.getPairsPage()).rejects.toMatchObject({ kind: "validation" });
  });
});
