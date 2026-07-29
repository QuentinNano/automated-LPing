import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MeteoraAdapter, TokenBucket, WSOL_MINT, normalizeMeteoraPair } from "@lping/adapters";
import { FEATURE_KEYS, buildFeatureVector, feeCurrencyOf } from "@lping/core";
import { fetchQueue, jsonResponse } from "./helpers";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const legacyPair = JSON.parse(readFileSync(path.join(fixturesDir, "meteora-pair.json"), "utf8"));
const datapiPage = JSON.parse(
  readFileSync(path.join(fixturesDir, "meteora-datapi-pools.json"), "utf8"),
);
/** Antwortform genau nach OpenAPI-Spezifikation (siehe Fixture-Kommentar). */
const documentedPage = JSON.parse(
  readFileSync(path.join(fixturesDir, "meteora-datapi-pools-documented.json"), "utf8"),
);

const fastLimiter = () => new TokenBucket(1000);

describe("normalizeMeteoraPair", () => {
  it("liest das Format der aktuellen datapi-Schnittstelle", () => {
    const pool = normalizeMeteoraPair(datapiPage.data[0]);
    expect(pool).not.toBeNull();
    expect(pool!.poolAddress).toBe("BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y");
    // Mints stecken in token_x/token_y-Objekten …
    expect(pool!.mintX).toBe("EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm");
    expect(pool!.mintY).toBe("So11111111111111111111111111111111111111112");
    // … bin_step und Basisgebühr in pool_config …
    expect(pool!.binStep).toBe(100);
    expect(pool!.baseFeePct).toBe(1);
    expect(pool!.maxFeePct).toBe(10);
    // … Volumen und Fees im 24-Stunden-Fenster verschachtelter Objekte.
    expect(pool!.tvlUsd).toBeCloseTo(250000.42);
    expect(pool!.volume24hUsd).toBeCloseTo(1250000.75);
    expect(pool!.fees24hUsd).toBeCloseTo(12500.5);
    expect(pool!.priceNative).toBeCloseTo(0.0000214);
  });

  it("bevorzugt das von der API gelieferte Fee/TVL-Verhältnis", () => {
    const pool = normalizeMeteoraPair(datapiPage.data[0]);
    // fee_tvl_ratio.hour_24 = 5.0 (statt selbst gerechnet)
    expect(pool!.feeTvl24hPct).toBe(5.0);
  });

  it("rechnet Fee/TVL selbst, wenn die API es nicht mitliefert", () => {
    const pool = normalizeMeteoraPair(datapiPage.data[1]);
    // 8120 / 812000 × 100 = 1 %
    expect(pool!.feeTvl24hPct).toBeCloseTo(1);
  });

  it("überspringt von Meteora als problematisch markierte Pools", () => {
    expect(normalizeMeteoraPair(datapiPage.data[2])).toBeNull();
  });

  it("nutzt die dynamische Gebühr, wenn keine Basisgebühr angegeben ist", () => {
    const raw = JSON.parse(JSON.stringify(datapiPage.data[0])) as Record<string, unknown>;
    delete (raw["pool_config"] as Record<string, unknown>)["base_fee_pct"];
    expect(normalizeMeteoraPair(raw)!.baseFeePct).toBeCloseTo(1.42);
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

  it("akzeptiert Zahlen, die als Strings geliefert werden — auch verschachtelt", () => {
    const pool = normalizeMeteoraPair(datapiPage.data[1]);
    expect(pool!.tvlUsd).toBe(812000);
    expect(pool!.volume24hUsd).toBe(2100000);
    expect(pool!.baseFeePct).toBe(0.8);
  });

  it("erkennt verschiedene Schreibweisen des 24-Stunden-Fensters", () => {
    const base = {
      address: "A",
      token_x: { address: "x" },
      token_y: { address: "y" },
      pool_config: { bin_step: 100 },
    };
    for (const key of ["hour_24", "h24", "24h", "day_1"]) {
      const pool = normalizeMeteoraPair({ ...base, volume: { [key]: 42 } });
      expect(pool!.volume24hUsd, key).toBe(42);
    }
  });

  it("verwirft Datensätze ohne Pflichtangaben statt zu raten", () => {
    expect(normalizeMeteoraPair({ address: "X", pool_config: { bin_step: 100 } })).toBeNull();
    expect(normalizeMeteoraPair({ mint_x: "a", mint_y: "b" })).toBeNull();
    expect(normalizeMeteoraPair(null)).toBeNull();
    expect(normalizeMeteoraPair("nope")).toBeNull();
  });
});

/**
 * Diese Gruppe prüft gegen die **dokumentierte** Antwortform der
 * OpenAPI-Spezifikation. Sie soll brechen, wenn Meteora Feldnamen ändert —
 * andernfalls verarmt der aufgezeichnete Datensatz still, und aufgezeichnete
 * Zeit lässt sich nicht nachholen.
 */
describe("normalizeMeteoraPair (dokumentierte Antwortform)", () => {
  const onlyY = () => normalizeMeteoraPair(documentedPage.data[0])!;
  const inputOnly = () => normalizeMeteoraPair(documentedPage.data[1])!;

  it("liest alle sechs Zeitfenster für Volumen, Gebühren und Fee/TVL", () => {
    const pool = onlyY();
    expect(pool.volumeUsd).toEqual({
      m30: 7333.3,
      h1: 16000,
      h2: 27333.3,
      h4: 55333.3,
      h12: 173333.3,
      h24: 333346.6,
    });
    expect(pool.feesUsd.m30).toBeCloseTo(275);
    expect(pool.feesUsd.h1).toBeCloseTo(600);
    expect(pool.feesUsd.h24).toBeCloseTo(12500.5);
    expect(pool.feeTvlPct.h1).toBeCloseTo(0.24);
    expect(pool.feeTvlPct.h24).toBeCloseTo(5);
    expect(pool.protocolFeesUsd.h24).toBeCloseTo(2500.1);
  });

  it("hält die 24-Stunden-Kürzel deckungsgleich mit dem h24-Fenster", () => {
    const pool = onlyY();
    expect(pool.volume24hUsd).toBe(pool.volumeUsd.h24);
    expect(pool.fees24hUsd).toBe(pool.feesUsd.h24);
    expect(pool.feeTvl24hPct).toBe(pool.feeTvlPct.h24);
  });

  it("rechnet fehlende Fenster des Fee/TVL-Verhältnisses aus Gebühren und TVL", () => {
    // Die Fixture liefert fee_tvl_ratio nur für 1h und 24h, fees aber ebenso
    // wenig für 30m — dort darf nichts erfunden werden.
    const pool = inputOnly();
    expect(pool.feeTvlPct.h1).toBeCloseTo(0.05);
    expect(pool.feeTvlPct.m30).toBeUndefined();
    // 4h fehlt im Verhältnis und in den Gebühren → bleibt leer.
    expect(pool.feeTvlPct.h4).toBeUndefined();
  });

  it("trennt Basisgebühr, dynamische Gebühr, Maximum und Protokollanteil", () => {
    const pool = onlyY();
    expect(pool.baseFeePct).toBe(1);
    // Der Satz, mit dem Swaps tatsächlich belastet werden — deutlich über base.
    expect(pool.dynamicFeePct).toBe(3.75);
    expect(pool.maxFeePct).toBe(10);
    // Launch-Pool: 20 % der Gebühr gehen ans Protokoll, nicht an den LP.
    expect(pool.protocolFeePct).toBe(20);
  });

  it("liest collect_fee_mode als Modus statt als Zahl", () => {
    expect(onlyY().collectFeeMode).toBe("only_y");
    expect(inputOnly().collectFeeMode).toBe("input_only");
  });

  it("liest Token-Angaben inklusive Freeze-Authority und Holder-Zahl", () => {
    const pool = onlyY();
    expect(pool.tokenX).toMatchObject({
      mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
      symbol: "MEME",
      holders: 4821,
      isVerified: false,
      freezeAuthorityDisabled: true,
      marketCapUsd: 2450000,
    });
    // false darf nicht verloren gehen: "nicht entzogen" ist die Warnung.
    expect(inputOnly().tokenY?.freezeAuthorityDisabled).toBe(false);
    expect(inputOnly().tokenY?.holders).toBe(91);
  });

  it("liest Farm-Kennzahlen und filtert Platzhalter-Reward-Mints", () => {
    const pool = onlyY();
    expect(pool.hasFarm).toBe(true);
    expect(pool.farmApr).toBe(18.4);
    expect(pool.rewardMints).toEqual(["MetDMetDMetDMetDMetDMetDMetDMetDMetDMetDMet"]);
    // Pool ohne Rewards: beide Mints sind der Platzhalter.
    expect(inputOnly().rewardMints).toEqual([]);
    expect(inputOnly().hasFarm).toBe(false);
  });

  it("liest Tags, Launchpad und den Pool-Erstellungszeitpunkt", () => {
    const pool = onlyY();
    expect(pool.tags).toEqual(["verified", "trending"]);
    expect(pool.launchpad).toBe("pump.fun");
    // created_at kommt als Unix-Sekunden (1785312000).
    expect(pool.poolCreatedAt?.toISOString()).toBe("2026-07-29T08:00:00.000Z");
    // launchpad: null darf nicht als String "null" durchkommen.
    expect(inputOnly().launchpad).toBeUndefined();
    expect(inputOnly().tags).toEqual([]);
  });

  it("akzeptiert created_at auch als ISO-String", () => {
    const raw = { ...documentedPage.data[0], created_at: "2026-07-28T09:00:00Z" };
    expect(normalizeMeteoraPair(raw)!.poolCreatedAt?.toISOString()).toBe(
      "2026-07-28T09:00:00.000Z",
    );
  });

  it("überspringt blacklistete Pools auch in der dokumentierten Form", () => {
    expect(normalizeMeteoraPair(documentedPage.data[2])).toBeNull();
  });
});

/**
 * Ende-zu-Ende: Von der dokumentierten API-Antwort bis in den Merkmalsvektor.
 * Ohne diesen Test kann der Adapter ein Feld korrekt lesen, während es auf dem
 * Weg in die Aufzeichnung verloren geht — der Datensatz wäre still unvollständig.
 */
describe("dokumentierte Antwort → Merkmalsvektor", () => {
  const vectorFor = (index: number) =>
    buildFeatureVector({
      pool: normalizeMeteoraPair(documentedPage.data[index])!,
      market: null,
      risk: null,
      sellability: null,
      organics: null,
      priceDivergencePct: null,
      now: new Date("2026-07-29T20:00:00Z"),
    });

  it("überträgt Zeitfenster, Gebührenstruktur und Pool-Alter", () => {
    const vector = vectorFor(0);

    expect(vector["pool_volume_30m_usd"]).toBe(7333.3);
    expect(vector["pool_volume_1h_usd"]).toBe(16000);
    expect(vector["fee_tvl_1h_pct"]).toBeCloseTo(0.24);
    expect(vector["dynamic_fee_pct"]).toBe(3.75);
    expect(vector["protocol_fee_pct"]).toBe(20);
    expect(vector["collect_fee_mode"]).toBe("only_y");
    expect(vector["fee_currency"]).toBe("quote");
    // created_at 2026-07-29T08:00Z, Bezugszeit 20:00Z → 12 h.
    expect(vector["pool_age_hours"]).toBeCloseTo(12);
    expect(vector["has_farm"]).toBe(true);
    expect(vector["farm_apr"]).toBe(18.4);
    expect(vector["launchpad"]).toBe("pump.fun");
    expect(vector["pool_tags"]).toBe("verified|trending");
  });

  it("berechnet Trend und Stetigkeit aus den echten Fenstern", () => {
    const vector = vectorFor(0);
    // Fee/TVL 1h = 0,24 %/h gegen 24h = 5 %/24h ≈ 0,208 %/h → leicht anziehend.
    expect(vector["fee_tvl_trend_1h_vs_24h"]).toBeCloseTo(0.24 / (5 / 24), 3);
    // Stundenraten der Fixture liegen zwischen 13.667 und 16.000 USD/h,
    // die letzte Stunde etwas über dem Schnitt → 13.667/16.000 ≈ 0,85.
    expect(vector["volume_steadiness"]).toBeCloseTo(0.854, 2);
  });

  it("übernimmt die Token-Angaben der Nicht-SOL-Seite aus der Pool-API", () => {
    expect(vectorFor(0)["pool_token_holders"]).toBe(4821);
    expect(vectorFor(0)["pool_freeze_authority_disabled"]).toBe(true);
    // Zweiter Pool: SOL ist Token X, die Token-Seite ist also Y.
    expect(vectorFor(1)["pool_token_holders"]).toBe(91);
    expect(vectorFor(1)["pool_freeze_authority_disabled"]).toBe(false);
  });

  it("liefert für jedes deklarierte Merkmal einen Wert", () => {
    expect(Object.keys(vectorFor(0)).sort()).toEqual([...FEATURE_KEYS].sort());
  });
});

describe("feeCurrencyOf", () => {
  it("erkennt Pools, deren Gebühren vollständig in SOL anfallen", () => {
    // collect_fee_mode = OnlyY und SOL ist Token Y → alle Gebühren in SOL.
    const pool = normalizeMeteoraPair(documentedPage.data[0])!;
    expect(pool.mintY).toBe(WSOL_MINT);
    expect(feeCurrencyOf(pool, WSOL_MINT)).toBe("quote");
  });

  it("erkennt, dass derselbe Modus mit SOL auf der X-Seite nachteilig ist", () => {
    // Gleicher Modus, aber SOL ist Token X: dann fallen alle Gebühren im
    // anderen Token an — genau umgekehrt zum erwünschten Fall.
    const pool = normalizeMeteoraPair({
      ...documentedPage.data[1],
      pool_config: { ...documentedPage.data[1].pool_config, collect_fee_mode: 1 },
    })!;
    expect(pool.mintX).toBe(WSOL_MINT);
    expect(feeCurrencyOf(pool, WSOL_MINT)).toBe("base");
  });

  it("meldet gemischte Gebühren bei InputOnly und Unwissen ohne Angabe", () => {
    expect(feeCurrencyOf(normalizeMeteoraPair(documentedPage.data[1])!, WSOL_MINT)).toBe("mixed");
    const withoutMode = normalizeMeteoraPair({
      ...documentedPage.data[0],
      pool_config: { bin_step: 100 },
    })!;
    expect(feeCurrencyOf(withoutMode, WSOL_MINT)).toBeNull();
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

  it("meldet die Rohanzahl getrennt von den verwertbaren Einträgen", async () => {
    // Wer die Pagination an pairs.length hängt, bricht hier nach einer Seite ab,
    // obwohl die Quelle eine volle Seite geliefert hat.
    const { fetchImpl } = fetchQueue([
      jsonResponse({ data: [datapiPage.data[0], datapiPage.data[2], { garbage: true }] }),
    ]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    const page = await adapter.getPairsPage({ limit: 3 });

    expect(page.pairs).toHaveLength(1);
    expect(page.skipped).toBe(2);
    expect(page.rawCount).toBe(3);
  });

  it("gibt Sortierung und Filter an die Schnittstelle weiter", async () => {
    const { fetchImpl, calls } = fetchQueue([jsonResponse(documentedPage)]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    const page = await adapter.getPairsPage({
      limit: 1000,
      sortBy: "pool_created_at:desc",
      filterBy: "is_blacklisted=false && tvl>=25000",
    });

    const url = new URL(calls[0]!);
    expect(url.searchParams.get("sort_by")).toBe("pool_created_at:desc");
    expect(url.searchParams.get("filter_by")).toBe("is_blacklisted=false && tvl>=25000");
    expect(url.searchParams.get("page_size")).toBe("1000");
    expect(page.serverFiltered).toBe(true);
  });

  it("begrenzt page_size auf das dokumentierte Maximum", async () => {
    const { fetchImpl, calls } = fetchQueue([jsonResponse(documentedPage)]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    await adapter.getPairsPage({ limit: 5000 });

    expect(new URL(calls[0]!).searchParams.get("page_size")).toBe("1000");
  });

  it("markiert die ältere Schnittstelle als nicht serverseitig gefiltert", async () => {
    // Sie kennt weder sort_by noch filter_by — der Aufrufer muss selbst filtern.
    const { fetchImpl } = fetchQueue([
      jsonResponse({ error: "not found" }, 404),
      jsonResponse([legacyPair]),
    ]);
    const adapter = new MeteoraAdapter({ fetchImpl, limiter: fastLimiter() });

    const page = await adapter.getPairsPage({ filterBy: "tvl>=25000" });

    expect(page.source).toBe("legacy");
    expect(page.serverFiltered).toBe(false);
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
