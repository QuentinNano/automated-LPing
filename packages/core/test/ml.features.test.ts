import { describe, expect, it } from "vitest";
import {
  FEATURE_KEYS,
  FEATURE_VERSION,
  buildFeatureVector,
  featureHeader,
  featureRow,
  type TokenOrganics,
} from "@lping/core";
import { TOKEN_MINT, buildMarket, buildPool, buildRisk, buildSellability } from "./builders";

function buildOrganics(overrides: Partial<TokenOrganics> = {}): TokenOrganics {
  return {
    mint: TOKEN_MINT,
    organicScore: 72.5,
    organicScoreLabel: "high",
    holderCount: 51_000,
    isVerified: true,
    mintAuthorityDisabled: true,
    freezeAuthorityDisabled: true,
    topHoldersPct: 11.2,
    fdvUsd: 3_890_000,
    liquidityUsd: 400_000,
    tags: ["verified"],
    fetchedAt: new Date("2026-07-29T12:00:00Z"),
    source: "jupiter-tokens",
    ...overrides,
  };
}

const fullInput = () => ({
  pool: buildPool(),
  market: buildMarket(),
  risk: buildRisk(),
  sellability: buildSellability(),
  organics: buildOrganics(),
  priceDivergencePct: 0.4,
});

describe("buildFeatureVector", () => {
  it("liefert genau die deklarierten Merkmale", () => {
    const vector = buildFeatureVector(fullInput());
    expect(Object.keys(vector).sort()).toEqual([...FEATURE_KEYS].sort());
  });

  it("übernimmt Pool-, Markt-, Risiko- und Organik-Werte", () => {
    const vector = buildFeatureVector(fullInput());
    expect(vector["bin_step"]).toBe(100);
    expect(vector["tvl_usd"]).toBeCloseTo(250_000);
    expect(vector["vol_tvl_ratio"]).toBeCloseTo(5);
    expect(vector["token_age_hours"]).toBe(24);
    expect(vector["risk_score"]).toBe(6);
    expect(vector["organic_score"]).toBe(72.5);
    expect(vector["organic_score_label"]).toBe("high");
    expect(vector["jup_holder_count"]).toBe(51_000);
    expect(vector["price_divergence_pct"]).toBe(0.4);
  });

  it("berechnet abgeleitete Merkmale", () => {
    const vector = buildFeatureVector(fullInput());
    // 3200 Käufe / 3100 Verkäufe
    expect(vector["buy_sell_ratio"]).toBeCloseTo(3200 / 3100);
    // 1.5 Mio Volumen / 6300 Trades
    expect(vector["avg_trade_usd"]).toBeCloseTo(1_500_000 / 6300);
    // Pool-TVL 250k von 400k Gesamtliquidität
    expect(vector["tvl_ratio_pool_to_market"]).toBeCloseTo(0.625);
  });

  it("markiert Widersprüche zwischen den Risikoquellen", () => {
    const agree = buildFeatureVector(fullInput());
    expect(agree["authority_agreement"]).toBe("agree");

    // RugCheck sagt "entzogen", Jupiter sagt "aktiv" — ein eigenes Warnsignal.
    const conflict = buildFeatureVector({
      ...fullInput(),
      organics: buildOrganics({ freezeAuthorityDisabled: false }),
    });
    expect(conflict["authority_agreement"]).toBe("conflict");

    const partial = buildFeatureVector({ ...fullInput(), organics: null });
    expect(partial["authority_agreement"]).toBe("partial");

    const unknown = buildFeatureVector({ ...fullInput(), risk: null, organics: null });
    expect(unknown["authority_agreement"]).toBe("unknown");
  });

  it("setzt fehlende Quellen auf null, statt Werte zu erfinden", () => {
    const vector = buildFeatureVector({
      pool: buildPool(),
      market: null,
      risk: null,
      sellability: null,
      organics: null,
      priceDivergencePct: null,
    });
    for (const key of ["token_age_hours", "risk_score", "organic_score", "roundtrip_loss_pct"]) {
      expect(vector[key], key).toBeNull();
    }
    // Pool-Daten liegen trotzdem vor.
    expect(vector["bin_step"]).toBe(100);
  });

  it("enthält keine Information aus der Zukunft", () => {
    // Schutz gegen Look-Ahead-Bias: Merkmalsnamen dürfen keine Ergebnisgrößen
    // tragen. Ergebnisse werden ausschließlich in candidate_outcomes geführt.
    const forbidden = ["outcome", "future", "pnl", "realized", "profit", "return_"];
    for (const key of FEATURE_KEYS) {
      for (const term of forbidden) {
        expect(key.includes(term), `${key} sieht nach einem Ergebnis aus`).toBe(false);
      }
    }
  });

  it("Feature-Version ist gesetzt", () => {
    expect(FEATURE_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe("CSV-Export", () => {
  it("Kopfzeile und Datenzeile haben gleich viele Spalten", () => {
    const vector = buildFeatureVector(fullInput());
    expect(featureRow(vector).split(",")).toHaveLength(featureHeader().split(",").length);
  });

  it("kodiert null als leer und Booleans als 0/1", () => {
    const vector = buildFeatureVector({
      pool: buildPool(),
      market: null,
      risk: buildRisk(),
      sellability: null,
      organics: null,
      priceDivergencePct: null,
    });
    const columns = featureRow(vector).split(",");
    const index = FEATURE_KEYS.indexOf("mint_authority_revoked");
    expect(columns[index]).toBe("1");
    expect(columns[FEATURE_KEYS.indexOf("organic_score")]).toBe("");
  });
});
