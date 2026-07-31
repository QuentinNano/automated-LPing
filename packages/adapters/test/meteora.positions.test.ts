import { describe, expect, it } from "vitest";
import { MeteoraAdapter, TokenBucket } from "@lping/adapters";
import { fetchQueue, jsonResponse } from "./helpers";
import positions from "./fixtures/meteora-positions.json";
import portfolio from "./fixtures/meteora-portfolio.json";

/**
 * Die Positions-Endpunkte sind wie alle Meteora-APIs nicht formal versioniert;
 * ihre Antwortform ließ sich beim Bau nicht gegen den Live-Dienst prüfen.
 * Gelesen wird deshalb über Alias-Listen, und ein Datensatz ohne Pflichtangaben
 * wird übersprungen statt den ganzen Abruf zu verwerfen — dasselbe Verhalten
 * wie bei den Pool-Metriken.
 */
function adapter(entries: Parameters<typeof fetchQueue>[0]) {
  const { fetchImpl, calls } = fetchQueue(entries);
  return {
    meteora: new MeteoraAdapter({ fetchImpl, limiter: new TokenBucket(1000) }),
    calls,
  };
}

const WALLET = "WalletZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
const POOL = "PoolXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

describe("getPositions", () => {
  it("liest geschlossene Positionen mit Zeitraum, Einsatz und Gebühren", async () => {
    const { meteora, calls } = adapter([jsonResponse(positions)]);
    const found = await meteora.getPositions(POOL, WALLET, { status: "closed" });

    expect(calls[0]).toContain(`/positions/${POOL}/pnl`);
    expect(calls[0]).toContain(`user=${WALLET}`);
    expect(calls[0]).toContain("status=closed");

    // Der dritte Datensatz hat weder Zeitraum noch Adresse — er fällt raus,
    // statt den Abruf zu verwerfen.
    expect(found).toHaveLength(2);

    const first = found[0]!;
    expect(first.positionAddress).toBe("PosAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
    expect(first.status).toBe("closed");
    expect(first.depositSol).toBe(12.5);
    expect(first.feesSol).toBe(0.0812);
    expect(first.minBinId).toBe(-40);
    expect(first.maxBinId).toBe(39);
    expect(first.openedAt?.toISOString()).toBe("2026-07-25T17:20:00.000Z");
    expect(first.closedAt?.toISOString()).toBe("2026-07-26T17:20:00.000Z");
  });

  it("versteht Zeitstempel als Epoch-Sekunden und als ISO-Text", async () => {
    const { meteora } = adapter([jsonResponse(positions)]);
    const found = await meteora.getPositions(POOL, WALLET);
    expect(found[1]!.openedAt?.toISOString()).toBe("2026-07-20T08:00:00.000Z");
    // Ohne Schlusszeitpunkt und ohne "closed" bleibt die Position offen.
    expect(found[1]!.status).toBe("open");
    expect(found[1]!.closedAt).toBeNull();
  });

  it("erfindet keine Bin-Range, wo keine gemeldet wird", async () => {
    const { meteora } = adapter([jsonResponse(positions)]);
    const found = await meteora.getPositions(POOL, WALLET);
    expect(found[1]!.minBinId).toBeUndefined();
    expect(found[1]!.maxBinId).toBeUndefined();
  });
});

describe("getPortfolio", () => {
  it("liest Pools und Positionsadressen in beiden Verpackungen", async () => {
    const { meteora, calls } = adapter([jsonResponse(portfolio)]);
    const pools = await meteora.getPortfolio(WALLET, { status: "open" });

    expect(calls[0]).toContain("/portfolio/open");
    expect(pools).toHaveLength(2);
    expect(pools[0]!.poolAddress).toBe(POOL);
    expect(pools[0]!.positionAddresses).toEqual([
      "PosAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ]);
    // Zweiter Eintrag: Adresse unter `address`, Positionen als Objekte.
    expect(pools[1]!.positionAddresses).toEqual([
      "PosDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    ]);
  });

  it("nimmt für geschlossene Positionen den anderen Endpunkt", async () => {
    const { meteora, calls } = adapter([jsonResponse(portfolio)]);
    await meteora.getPortfolio(WALLET, { status: "closed" });
    expect(calls[0]).toContain("/portfolio?");
    expect(calls[0]).not.toContain("/portfolio/open");
  });
});
