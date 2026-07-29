import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MeteoraAdapter, TokenBucket, normalizeMeteoraPair } from "@lping/adapters";
import { fetchQueue, jsonResponse } from "./helpers";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const legacyPair = JSON.parse(readFileSync(path.join(fixturesDir, "meteora-pair.json"), "utf8"));
const datapiPage = JSON.parse(
  readFileSync(path.join(fixturesDir, "meteora-datapi-pools.json"), "utf8"),
);

const fastLimiter = () => new TokenBucket(1000);

describe("normalizeMeteoraPair", () => {
  it("liest das Format der aktuellen datapi-Schnittstelle (verschachtelte Token)", () => {
    const pool = normalizeMeteoraPair(datapiPage.data[0]);
    expect(pool).not.toBeNull();
    expect(pool!.poolAddress).toBe("BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y");
    expect(pool!.mintX).toBe("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm");
    expect(pool!.mintY).toBe("So11111111111111111111111111111111111111112");
    expect(pool!.tvlUsd).toBeCloseTo(250000.42);
    expect(pool!.volume24hUsd).toBeCloseTo(1250000.75);
    expect(pool!.feeTvl24hPct).toBeCloseTo(5.0, 1);
    expect(pool!.priceNative).toBeCloseTo(0.0000214);
  });

  it("liest das ältere Format mit flachen mint_x/mint_y-Feldern", () => {
    const pool = normalizeMeteoraPair(legacyPair);
    expect(pool).not.toBeNull();
    expect(pool!.mintX).toBe("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm");
    expect(pool!.binStep).toBe(100);
    expect(pool!.baseFeePct).toBe(1);
    expect(pool!.tvlUsd).toBeCloseTo(250000.42);
    expect(pool!.volume24hUsd).toBeCloseTo(1250000.75);
  });

  it("akzeptiert Zahlen, die als Strings geliefert werden", () => {
    const pool = normalizeMeteoraPair(datapiPage.data[1]);
    expect(pool!.tvlUsd).toBe(812000);
    expect(pool!.volume24hUsd).toBe(2100000);
  });

  it("verwirft Datensätze ohne Pflichtangaben statt zu raten", () => {
    expect(normalizeMeteoraPair({ address: "X", bin_step: 100 })).toBeNull();
    expect(normalizeMeteoraPair({ mint_x: "a", mint_y: "b", bin_step: 100 })).toBeNull();
    expect(normalizeMeteoraPair(null)).toBeNull();
    expect(normalizeMeteoraPair("nope")).toBeNull();
  });
});

describe("MeteoraAdapter", () => {
  it("nutzt die aktuelle Schnittstelle mit 1-basierten Seiten", async () => {
    const { fetchImpl, calls } = fetchQueue([jsonResponse(datapiPage)]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    const page = await adapter.getPairsPage({ page: 0, limit: 2 });

    expect(page.source).toBe("datapi");
    expect(page.pairs).toHaveLength(2);
    expect(page.total).toBe(4821);
    expect(calls[0]).toContain("dlmm.datapi.meteora.ag/pools");
    // Seite 0 des Bots entspricht Seite 1 der API.
    expect(calls[0]).toContain("page=1");
    expect(calls[0]).toContain("page_size=2");
  });

  it("weicht auf die ältere Schnittstelle aus, wenn die neue 404 liefert", async () => {
    const { fetchImpl, calls } = fetchQueue([
      jsonResponse({ error: "not found" }, 404),
      jsonResponse([legacyPair]),
    ]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    const page = await adapter.getPairsPage({ page: 0, limit: 50 });

    expect(page.source).toBe("legacy");
    expect(page.pairs).toHaveLength(1);
    expect(calls[1]).toContain("dlmm-api.meteora.ag/pair/all");
  });

  it("merkt sich die funktionierende Quelle für Folgeabrufe", async () => {
    const { fetchImpl, calls } = fetchQueue([
      jsonResponse({ error: "not found" }, 404),
      jsonResponse([legacyPair]),
      jsonResponse([legacyPair]),
    ]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    await adapter.getPairsPage({ limit: 50 });
    await adapter.getPairsPage({ limit: 50 });

    // Der zweite Abruf geht direkt an die bekannte Quelle, ohne erneuten 404.
    expect(calls).toHaveLength(3);
    expect(calls[2]).toContain("dlmm-api.meteora.ag");
  });

  it("paginiert clientseitig, wenn die Quelle alles am Stück liefert", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...legacyPair,
      address: `Pool${String(i).padStart(38, "x")}`,
    }));
    const { fetchImpl } = fetchQueue([
      jsonResponse({ error: "not found" }, 404),
      jsonResponse(many),
    ]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    const page = await adapter.getPairsPage({ page: 1, limit: 5 });

    expect(page.pairs).toHaveLength(5);
    expect(page.pairs[0]?.poolAddress).toBe(many[5]!.address);
    expect(page.total).toBe(12);
  });

  it("überspringt unbrauchbare Einträge, statt den Abruf zu verwerfen", async () => {
    const { fetchImpl } = fetchQueue([
      jsonResponse({ data: [datapiPage.data[0], { garbage: true }] }),
    ]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    const page = await adapter.getPairsPage();

    expect(page.pairs).toHaveLength(1);
    expect(page.skipped).toBe(1);
  });

  it("meldet einen Fehler, wenn keine Quelle antwortet", async () => {
    const { fetchImpl } = fetchQueue([
      jsonResponse({ error: "nope" }, 404),
      jsonResponse({ error: "nope" }, 404),
    ]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });
    await expect(adapter.getPairsPage()).rejects.toMatchObject({ kind: "http" });
  });

  it("getPair packt eine in {data:…} verschachtelte Einzelantwort aus", async () => {
    const { fetchImpl } = fetchQueue([jsonResponse({ data: datapiPage.data[0] })]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    const pool = await adapter.getPair("BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y");

    expect(pool.binStep).toBe(100);
    expect(pool.mintY).toBe("So11111111111111111111111111111111111111112");
  });
});
