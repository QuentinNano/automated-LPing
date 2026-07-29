import { describe, expect, it } from "vitest";
import { runHardFilters, screenCandidate } from "@lping/core";
import {
  buildInput,
  buildMarket,
  buildPool,
  buildRisk,
  buildSellability,
  loadDefaultConfig,
} from "./builders";

const config = loadDefaultConfig();

function checksById(input: Parameters<typeof runHardFilters>[0]) {
  return new Map(runHardFilters(input).map((c) => [c.id, c]));
}

describe("Hard Filters", () => {
  it("akzeptiert einen rundum gesunden Degen-Kandidaten", () => {
    const result = screenCandidate(buildInput("degen", config));
    expect(result.verdict).toBe("accepted");
    expect(result.rejectedBy).toEqual([]);
    const failed = result.checks.filter((c) => c.status === "failed");
    expect(failed).toEqual([]);
  });

  it("markiert nur die RPC-abhängige LP-Dominanz-Prüfung als skipped", () => {
    const checks = runHardFilters(buildInput("degen", config));
    const skipped = checks.filter((c) => c.status === "skipped").map((c) => c.id);
    expect(skipped).toEqual(["single_lp_dominance"]);
  });

  it("fail-closed: ohne Risiko-Report fallen alle Token-Sicherheitschecks durch", () => {
    const checks = checksById(buildInput("degen", config, { risk: null }));
    for (const id of [
      "mint_authority_revoked",
      "freeze_authority_revoked",
      "risk_score",
      "risk_flags",
      "top10_concentration",
      "single_holder",
      "insider_share",
      "min_holders",
    ]) {
      expect(checks.get(id)?.status, id).toBe("failed");
      expect(checks.get(id)?.detail, id).toContain("fail-closed");
    }
  });

  it("fail-closed: ohne Sellability-Check keine Freigabe", () => {
    const checks = checksById(buildInput("degen", config, { sellability: null }));
    expect(checks.get("sellable")?.status).toBe("failed");
  });

  it("lehnt aktive Freeze-Authority ab (Honeypot-Vektor)", () => {
    const checks = checksById(
      buildInput("degen", config, { risk: buildRisk({ freezeAuthorityRevoked: false }) }),
    );
    expect(checks.get("freeze_authority_revoked")?.status).toBe("failed");
  });

  it("lehnt kritische RugCheck-Flags (level danger) ab", () => {
    const checks = checksById(
      buildInput("degen", config, {
        risk: buildRisk({ risks: [{ name: "Freeze Authority still enabled", level: "danger" }] }),
      }),
    );
    expect(checks.get("risk_flags")?.status).toBe("failed");
    expect(String(checks.get("risk_flags")?.value)).toContain("Freeze Authority");
  });

  it("lehnt nicht verkaufbare Token ab", () => {
    const checks = checksById(
      buildInput("degen", config, {
        sellability: buildSellability({ verdict: "blocked", sellOk: false }),
      }),
    );
    expect(checks.get("sellable")?.status).toBe("failed");
  });

  it("lehnt absurdes Vol/TVL-Verhältnis ab (Wash-Trading-Verdacht)", () => {
    const checks = checksById(
      buildInput("degen", config, {
        pool: buildPool({ volume24hUsd: 250_000 * 60 }),
      }),
    );
    expect(checks.get("vol_tvl_ratio")?.status).toBe("failed");
  });

  it("lehnt Token außerhalb des Preset-Altersfensters ab", () => {
    const tooOld = checksById(
      buildInput("degen", config, { market: buildMarket({ tokenAgeHours: 100 }) }),
    );
    expect(tooOld.get("token_age")?.status).toBe("failed");

    const tooYoung = checksById(
      buildInput("multiday", config, { market: buildMarket({ tokenAgeHours: 24 }) }),
    );
    expect(tooYoung.get("token_age")?.status).toBe("failed");
  });

  it("lehnt Preis-Divergenz zwischen Pool und Markt ab", () => {
    const checks = checksById(
      buildInput("degen", config, {
        market: buildMarket({ medianPriceNative: 0.0000214 * 1.1 }),
      }),
    );
    expect(checks.get("price_divergence")?.status).toBe("failed");
  });

  it("überspringt Preis-Divergenz ohne Marktdaten statt zu blockieren", () => {
    const checks = checksById(buildInput("degen", config, { market: null }));
    expect(checks.get("price_divergence")?.status).toBe("skipped");
    // aber das Altersfenster ist ohne Marktdaten nicht belegbar → fail-closed
    expect(checks.get("token_age")?.status).toBe("failed");
  });

  it("lehnt Pools ab, die nicht SOL-quotiert sind", () => {
    const checks = checksById(
      buildInput("degen", config, {
        tokenMint: null,
        pool: buildPool({ mintY: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }),
      }),
    );
    expect(checks.get("quote_is_sol")?.status).toBe("failed");
  });

  it("min_score greift auch, wenn alle Hard Filters bestehen", () => {
    const result = screenCandidate(
      buildInput("degen", config, {
        pool: buildPool({ volume24hUsd: 625_000, fees24hUsd: 250, feeTvl24hPct: 0.1 }),
        market: buildMarket({
          txns24h: { buys: 60, sells: 40 },
          volume24hUsd: 20_000,
          priceChangeH6Pct: -5,
        }),
        risk: buildRisk({ normalizedScore: 38, top10HolderPct: 29 }),
      }),
    );
    const failedHard = result.checks.filter((c) => c.status === "failed");
    expect(failedHard).toEqual([]);
    expect(result.verdict).toBe("rejected");
    expect(result.rejectedBy).toEqual(["min_score"]);
    expect(result.score.total).toBeLessThan(config.presets.degen.minScore);
  });
});
