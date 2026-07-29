import { describe, expect, it } from "vitest";
import {
  FEATURE_KEYS,
  FEATURE_VERSION,
  WSOL_MINT,
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

describe("buildFeatureVector: Zeitfenster und Trends", () => {
  it("übernimmt die kurzen Fenster aus den Pool-Kennzahlen", () => {
    const pool = buildPool({
      volumeUsd: { m30: 8_000, h1: 15_000, h4: 40_000, h24: 240_000 },
      feeTvlPct: { m30: 0.1, h1: 0.25, h4: 0.8, h24: 4.8 },
    });
    const vector = buildFeatureVector({ ...fullInput(), pool });

    expect(vector["pool_volume_30m_usd"]).toBe(8_000);
    expect(vector["pool_volume_1h_usd"]).toBe(15_000);
    expect(vector["pool_volume_4h_usd"]).toBe(40_000);
    expect(vector["fee_tvl_30m_pct"]).toBe(0.1);
    expect(vector["fee_tvl_1h_pct"]).toBe(0.25);
    expect(vector["fee_tvl_4h_pct"]).toBe(0.8);
  });

  it("vergleicht Stundenraten statt Rohwerte", () => {
    // Fee/TVL: 1 h = 0,5 %, 24 h = 6 % → Tagesdurchschnitt 0,25 %/h.
    // Die aktuelle Rate ist doppelt so hoch: Ertragskraft zieht an.
    const pool = buildPool({ feeTvlPct: { h1: 0.5, h24: 6 }, volumeUsd: { h1: 10_000, h24: 240_000 } });
    const vector = buildFeatureVector({ ...fullInput(), pool });

    expect(vector["fee_tvl_trend_1h_vs_24h"]).toBeCloseTo(2);
    // Volumen: 10k/h gegen 10k/h Durchschnitt → kein Burst.
    expect(vector["volume_burst_1h"]).toBeCloseTo(1);
  });

  it("gibt null zurück, wenn ein Fenster für den Trend fehlt", () => {
    const pool = buildPool({ feeTvlPct: { h24: 6 }, volumeUsd: { h24: 240_000 } });
    const vector = buildFeatureVector({ ...fullInput(), pool });
    expect(vector["fee_tvl_trend_1h_vs_24h"]).toBeNull();
    expect(vector["volume_burst_1h"]).toBeNull();
  });

  it("misst Volumen-Stetigkeit über die Stundenraten", () => {
    // Gleiche Rate in jedem Fenster = völlig gleichmäßiger Handel.
    const steady = buildFeatureVector({
      ...fullInput(),
      pool: buildPool({ volumeUsd: { m30: 500, h1: 1_000, h2: 2_000, h4: 4_000, h24: 24_000 } }),
    });
    expect(steady["volume_steadiness"]).toBeCloseTo(1);

    // Das gesamte Tagesvolumen steckt in der letzten halben Stunde.
    const bursty = buildFeatureVector({
      ...fullInput(),
      pool: buildPool({ volumeUsd: { m30: 24_000, h1: 24_000, h2: 24_000, h4: 24_000, h24: 24_000 } }),
    });
    expect(bursty["volume_steadiness"]).toBeLessThan(0.05);
  });

  it("verweigert die Stetigkeit bei zu wenigen Fenstern", () => {
    const vector = buildFeatureVector({
      ...fullInput(),
      pool: buildPool({ volumeUsd: { h1: 1_000, h24: 24_000 } }),
    });
    expect(vector["volume_steadiness"]).toBeNull();
  });
});

describe("buildFeatureVector: Gebührenstruktur und Pool-Token", () => {
  it("führt dynamische Gebühr, Maximum und Protokollanteil getrennt", () => {
    const pool = buildPool({ baseFeePct: 1, dynamicFeePct: 3.75, maxFeePct: 10, protocolFeePct: 20 });
    const vector = buildFeatureVector({ ...fullInput(), pool });

    expect(vector["base_fee_pct"]).toBe(1);
    expect(vector["dynamic_fee_pct"]).toBe(3.75);
    expect(vector["max_fee_pct"]).toBe(10);
    expect(vector["protocol_fee_pct"]).toBe(20);
  });

  it("leitet die Gebührenwährung aus Modus und SOL-Seite ab", () => {
    // OnlyY + SOL als Token Y → alle Gebühren in SOL.
    const inSol = buildFeatureVector({
      ...fullInput(),
      pool: buildPool({ collectFeeMode: "only_y" }),
    });
    expect(inSol["collect_fee_mode"]).toBe("only_y");
    expect(inSol["fee_currency"]).toBe("quote");

    // Gleicher Modus, SOL auf der X-Seite → alle Gebühren im Memecoin.
    const inToken = buildFeatureVector({
      ...fullInput(),
      pool: buildPool({ collectFeeMode: "only_y", mintX: WSOL_MINT, mintY: TOKEN_MINT }),
    });
    expect(inToken["fee_currency"]).toBe("base");

    expect(buildFeatureVector(fullInput())["fee_currency"]).toBe("mixed");
  });

  it("nutzt die Token-Angaben der Pool-API von der Nicht-SOL-Seite", () => {
    const pool = buildPool({
      tokenX: {
        mint: TOKEN_MINT,
        holders: 4_821,
        isVerified: false,
        freezeAuthorityDisabled: true,
        marketCapUsd: 2_450_000,
      },
      tokenY: { mint: WSOL_MINT, holders: 1_200_000, isVerified: true },
    });
    const vector = buildFeatureVector({ ...fullInput(), pool });

    // Nicht die SOL-Seite: 4.821, nicht 1,2 Mio.
    expect(vector["pool_token_holders"]).toBe(4_821);
    expect(vector["pool_token_verified"]).toBe(false);
    expect(vector["pool_freeze_authority_disabled"]).toBe(true);
    expect(vector["pool_token_market_cap_usd"]).toBe(2_450_000);
  });

  it("berechnet das Pool-Alter getrennt vom Token-Alter", () => {
    const now = new Date("2026-07-29T12:00:00Z");
    const vector = buildFeatureVector({
      ...fullInput(),
      pool: buildPool({ poolCreatedAt: new Date("2026-07-29T06:00:00Z") }),
      now,
    });
    // Der Pool ist 6 h alt, der Token laut Markt-Daten 24 h — ein neuer Pool auf
    // einem älteren Token ist ein anderer Fall als ein neuer Token.
    expect(vector["pool_age_hours"]).toBeCloseTo(6);
    expect(vector["token_age_hours"]).toBe(24);
  });

  it("lässt Farm-Angaben und Herkunft durch", () => {
    const vector = buildFeatureVector({
      ...fullInput(),
      pool: buildPool({ hasFarm: true, farmApr: 18.4, launchpad: "pump.fun", tags: ["a", "b"] }),
    });
    expect(vector["has_farm"]).toBe(true);
    expect(vector["farm_apr"]).toBe(18.4);
    expect(vector["launchpad"]).toBe("pump.fun");
    expect(vector["pool_tags"]).toBe("a|b");
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
