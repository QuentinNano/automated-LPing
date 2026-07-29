import { describe, expect, it } from "vitest";
import { JupiterAdapter, TokenBucket, WSOL_MINT } from "@lping/adapters";
import { fetchQueue, jsonResponse } from "./helpers";

const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

const buyQuote = {
  inputMint: WSOL_MINT,
  inAmount: "100000000",
  outputMint: MINT,
  outAmount: "4500000000",
  otherAmountThreshold: "4455000000",
  swapMode: "ExactIn",
  slippageBps: 100,
  priceImpactPct: "0.42",
  routePlan: [{ swapInfo: {} }, { swapInfo: {} }],
};

const sellQuote = {
  inputMint: MINT,
  inAmount: "4500000000",
  outputMint: WSOL_MINT,
  outAmount: "97000000",
  otherAmountThreshold: "96030000",
  swapMode: "ExactIn",
  slippageBps: 100,
  priceImpactPct: "0.55",
  routePlan: [{ swapInfo: {} }],
};

describe("JupiterAdapter", () => {
  it("normalisiert Quotes", async () => {
    const { fetchImpl, calls } = fetchQueue([jsonResponse(buyQuote)]);
    const adapter = new JupiterAdapter({ fetchImpl, limiter: new TokenBucket(1000) });

    const quote = await adapter.getQuote({
      inputMint: WSOL_MINT,
      outputMint: MINT,
      amountRaw: "100000000",
    });

    expect(quote.inAmountRaw).toBe("100000000");
    expect(quote.outAmountRaw).toBe("4500000000");
    expect(quote.priceImpactPct).toBeCloseTo(0.42);
    expect(quote.routeHops).toBe(2);
    expect(calls[0]).toContain("inputMint=" + WSOL_MINT);
    expect(calls[0]).toContain("restrictIntermediateTokens=true");
  });

  it("bewertet einen Token mit funktionierendem Roundtrip als sellable", async () => {
    const { fetchImpl } = fetchQueue([jsonResponse(buyQuote), jsonResponse(sellQuote)]);
    const adapter = new JupiterAdapter({ fetchImpl, limiter: new TokenBucket(1000) });

    const check = await adapter.checkSellability(MINT, { probeSolLamports: 100_000_000 });

    expect(check.buyOk).toBe(true);
    expect(check.sellOk).toBe(true);
    // (100M - 97M) / 100M = 3 %
    expect(check.roundTripLossPct).toBeCloseTo(3);
    expect(check.verdict).toBe("sellable");
  });

  it("bewertet fehlende Verkaufsroute als blocked (Honeypot-Indikator)", async () => {
    const { fetchImpl } = fetchQueue([
      jsonResponse(buyQuote),
      jsonResponse({ error: "Could not find any route" }, 400),
    ]);
    const adapter = new JupiterAdapter({ fetchImpl, limiter: new TokenBucket(1000) });

    const check = await adapter.checkSellability(MINT);

    expect(check.buyOk).toBe(true);
    expect(check.sellOk).toBe(false);
    expect(check.verdict).toBe("blocked");
  });

  it("bewertet hohen Roundtrip-Verlust als illiquid", async () => {
    const { fetchImpl } = fetchQueue([
      jsonResponse(buyQuote),
      jsonResponse({ ...sellQuote, outAmount: "60000000" }),
    ]);
    const adapter = new JupiterAdapter({ fetchImpl, limiter: new TokenBucket(1000) });

    const check = await adapter.checkSellability(MINT, { maxImpactPct: 25 });

    expect(check.roundTripLossPct).toBeCloseTo(40);
    expect(check.verdict).toBe("illiquid");
  });

  it("reicht Serverfehler weiter statt sie als 'blocked' zu werten", async () => {
    const { fetchImpl } = fetchQueue([
      jsonResponse({ error: "internal" }, 500),
      jsonResponse({ error: "internal" }, 500),
      jsonResponse({ error: "internal" }, 500),
    ]);
    const adapter = new JupiterAdapter({ fetchImpl, limiter: new TokenBucket(1000) });
    await expect(adapter.checkSellability(MINT)).rejects.toMatchObject({ kind: "http" });
  });
});
