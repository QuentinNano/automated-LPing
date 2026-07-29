import { describe, expect, it } from "vitest";
import { JupiterTokenAdapter, TokenBucket, normalizeOrganics } from "@lping/adapters";
import { fetchQueue, jsonResponse } from "./helpers";

const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

const token = {
  id: MINT,
  name: "dogwifhat",
  symbol: "WIF",
  decimals: 6,
  holderCount: 51234,
  organicScore: 72.5,
  organicScoreLabel: "high",
  isVerified: true,
  tags: ["verified", "community"],
  audit: {
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    topHoldersPercentage: 11.2,
  },
  fdv: 3890000,
  mcap: 3890000,
  liquidity: 1834567.89,
};

const fast = () => new TokenBucket(1000);

describe("JupiterTokenAdapter", () => {
  it("liest Organic Score, Holder und Audit-Angaben", async () => {
    const { fetchImpl, calls } = fetchQueue([jsonResponse([token])]);
    const adapter = new JupiterTokenAdapter({ fetchImpl, limiter: fast() });

    const organics = await adapter.getOrganics(MINT);

    expect(organics).not.toBeNull();
    expect(organics!.organicScore).toBe(72.5);
    expect(organics!.organicScoreLabel).toBe("high");
    expect(organics!.holderCount).toBe(51234);
    expect(organics!.mintAuthorityDisabled).toBe(true);
    expect(organics!.topHoldersPct).toBeCloseTo(11.2);
    expect(organics!.tags).toContain("verified");
    expect(calls[0]).toContain(`query=${MINT}`);
  });

  it("nimmt nur den exakten Mint, nicht Symbol-Treffer", async () => {
    // Die Suche liefert auch namensähnliche Token — die dürfen nicht durchrutschen.
    const other = { ...token, id: "AndererMint1111111111111111111111111111111", symbol: "WIF" };
    const { fetchImpl } = fetchQueue([jsonResponse([other, token])]);
    const adapter = new JupiterTokenAdapter({ fetchImpl, limiter: fast() });

    const organics = await adapter.getOrganics(MINT);
    expect(organics!.mint).toBe(MINT);
    expect(organics!.organicScore).toBe(72.5);
  });

  it("liefert null, wenn Jupiter den Token nicht kennt", async () => {
    const { fetchImpl } = fetchQueue([jsonResponse([])]);
    const adapter = new JupiterTokenAdapter({ fetchImpl, limiter: fast() });
    expect(await adapter.getOrganics(MINT)).toBeNull();
  });

  it("akzeptiert Envelope-Varianten", async () => {
    for (const payload of [{ tokens: [token] }, { data: [token] }, token]) {
      const { fetchImpl } = fetchQueue([jsonResponse(payload)]);
      const adapter = new JupiterTokenAdapter({ fetchImpl, limiter: fast() });
      const organics = await adapter.getOrganics(MINT);
      expect(organics?.organicScore).toBe(72.5);
    }
  });

  it("normalisiert unbekannte Labels zu null statt sie durchzureichen", () => {
    expect(normalizeOrganics(MINT, { organicScoreLabel: "HIGH" }).organicScoreLabel).toBe("high");
    expect(normalizeOrganics(MINT, { organicScoreLabel: "seltsam" }).organicScoreLabel).toBeNull();
    expect(normalizeOrganics(MINT, {}).organicScoreLabel).toBeNull();
  });

  it("fehlende Angaben werden null, nicht 0 (unbekannt ≠ unbedenklich)", () => {
    const organics = normalizeOrganics(MINT, {});
    expect(organics.organicScore).toBeNull();
    expect(organics.holderCount).toBeNull();
    expect(organics.mintAuthorityDisabled).toBeNull();
    expect(organics.freezeAuthorityDisabled).toBeNull();
  });
});
