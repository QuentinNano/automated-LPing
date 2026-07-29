import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DexScreenerAdapter, TokenBucket } from "@lping/adapters";
import { fetchQueue, jsonResponse } from "./helpers";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const pairsFixture = JSON.parse(
  readFileSync(path.join(fixturesDir, "dexscreener-token-pairs.json"), "utf8"),
);

describe("DexScreenerAdapter", () => {
  it("normalisiert Token-Pairs inkl. Volumen, Trades und Pair-Alter", async () => {
    const { fetchImpl, calls } = fetchQueue([jsonResponse(pairsFixture)]);
    const adapter = new DexScreenerAdapter({ fetchImpl, limiter: new TokenBucket(1000) });

    const { pairs, skipped } = await adapter.getPairsForToken(
      "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
    );

    expect(skipped).toBe(0);
    expect(pairs).toHaveLength(1);
    const pair = pairs[0]!;
    expect(pair.dexId).toBe("meteora");
    expect(pair.baseToken).toEqual({
      mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
      symbol: "WIF",
    });
    expect(pair.quoteToken.mint).toBe("So11111111111111111111111111111111111111112");
    expect(pair.priceUsd).toBeCloseTo(0.00389);
    expect(pair.liquidityUsd).toBeCloseTo(250000.42);
    expect(pair.volume.h24).toBeCloseTo(1250000.75);
    expect(pair.txns.h24).toEqual({ buys: 3200, sells: 3100 });
    expect(pair.pairCreatedAt).toEqual(new Date(1753600000000));
    expect(calls[0]).toContain("/token-pairs/v1/solana/");
  });

  it("überspringt Einträge ohne Pflichtfelder", async () => {
    const { fetchImpl } = fetchQueue([jsonResponse([{ pairAddress: 123 }, ...pairsFixture])]);
    const adapter = new DexScreenerAdapter({ fetchImpl, limiter: new TokenBucket(1000) });
    const { pairs, skipped } = await adapter.getPairsForToken("X");
    expect(pairs).toHaveLength(1);
    expect(skipped).toBe(1);
  });
});
