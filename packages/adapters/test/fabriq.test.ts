import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FabriqAdapter, TokenBucket, extractFabriqPools } from "@lping/adapters";
import { fetchQueue, jsonResponse } from "./helpers";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const trendingFixture = JSON.parse(readFileSync(path.join(fixturesDir, "fabriq-trending.json"), "utf8"));

describe("extractFabriqPools", () => {
  it("findet Pools in verschachtelten Strukturen", () => {
    const pools = extractFabriqPools(trendingFixture);
    expect(pools).toHaveLength(2);
    expect(pools[0]).toMatchObject({
      poolAddress: "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y",
      name: "WIF-SOL",
      score: 312.4,
    });
  });

  it("ignoriert Objekte ohne Base58-Adresse", () => {
    expect(extractFabriqPools({ data: [{ name: "x", score: 1 }, { address: "not-base58!" }] })).toEqual(
      [],
    );
  });

  it("dedupliziert nach Pool-Adresse", () => {
    const pool = { address: "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y", score: 1 };
    expect(extractFabriqPools({ a: [pool], b: [pool] })).toHaveLength(1);
  });
});

describe("FabriqAdapter", () => {
  it("liefert ok + Pools bei parsebarer Antwort", async () => {
    const { fetchImpl, calls } = fetchQueue([jsonResponse(trendingFixture)]);
    const adapter = new FabriqAdapter({ fetchImpl, limiter: new TokenBucket(1000) });

    const result = await adapter.getTrending("degen");

    expect(result.status).toBe("ok");
    expect(result.pools).toHaveLength(2);
    expect(calls[0]).toContain("category=degen");
  });

  it("meldet schema_drift statt zu werfen, wenn nichts extrahierbar ist", async () => {
    const { fetchImpl } = fetchQueue([jsonResponse({ hello: "world" })]);
    const adapter = new FabriqAdapter({ fetchImpl, limiter: new TokenBucket(1000) });

    const result = await adapter.getTrending("degen");

    expect(result.status).toBe("schema_drift");
    expect(result.pools).toEqual([]);
  });

  it("meldet unavailable statt zu werfen, wenn der Endpoint nicht erreichbar ist", async () => {
    const failing = async () => {
      throw new TypeError("fetch failed");
    };
    const adapter = new FabriqAdapter({ fetchImpl: failing, limiter: new TokenBucket(1000) });

    const result = await adapter.getTrending("multiday");

    expect(result.status).toBe("unavailable");
    expect(result.pools).toEqual([]);
    expect(result.note).toBeDefined();
  });
});
