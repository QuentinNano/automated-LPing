import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RugcheckAdapter, TokenBucket, normalizeRugcheckReport } from "@lping/adapters";
import { fetchQueue, jsonResponse } from "./helpers";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const reportFixture = JSON.parse(readFileSync(path.join(fixturesDir, "rugcheck-report.json"), "utf8"));
const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";

describe("RugcheckAdapter", () => {
  it("normalisiert Report: Authorities, Holder-Konzentration, Insider", async () => {
    const { fetchImpl, calls } = fetchQueue([jsonResponse(reportFixture)]);
    const adapter = new RugcheckAdapter({ fetchImpl, limiter: new TokenBucket(1000) });

    const report = await adapter.getReport(MINT);

    expect(report.mint).toBe(MINT);
    expect(report.rawScore).toBe(501);
    expect(report.normalizedScore).toBe(6);
    expect(report.mintAuthorityRevoked).toBe(true);
    expect(report.freezeAuthorityRevoked).toBe(true);
    expect(report.topHolders).toHaveLength(3);
    expect(report.top10HolderPct).toBeCloseTo(10.4);
    expect(report.insiderPct).toBeCloseTo(3.1);
    expect(report.risks[0]?.name).toContain("Top 10 holders");
    expect(report.totalMarketLiquidityUsd).toBeCloseTo(1834567.89);
    expect(calls[0]).toContain(`/tokens/${MINT}/report`);
  });

  it("liefert tri-state null, wenn Token-Infos fehlen (kein stilles 'unbedenklich')", () => {
    const report = normalizeRugcheckReport(MINT, { token: null });
    expect(report.mintAuthorityRevoked).toBeNull();
    expect(report.freezeAuthorityRevoked).toBeNull();
    expect(report.top10HolderPct).toBeNull();
    expect(report.insiderPct).toBeNull();
    expect(report.rawScore).toBeNull();
  });

  it("erkennt nicht-revokete Authorities", () => {
    const report = normalizeRugcheckReport(MINT, {
      token: { mintAuthority: "SomeAuthorityPubkey11111111111111111111111", freezeAuthority: null },
    });
    expect(report.mintAuthorityRevoked).toBe(false);
    expect(report.freezeAuthorityRevoked).toBe(true);
  });
});
