import { describe, expect, it } from "vitest";
import type { PoolMetrics } from "@lping/core";
import {
  formatFeatureVersions,
  formatTrackStatus,
  runTrackCycle,
  type TrackDeps,
  type TrackStore,
} from "../src/track";
import { buildPool } from "../../../packages/core/test/builders";

const T0 = new Date("2026-07-29T12:00:00Z");

class FakeStore implements TrackStore {
  due: { poolAddress: string; tokenMint: string }[] = [];
  recorded: string[] = [];
  expired = 0;
  outcomes = 0;

  async duePools() {
    return this.due;
  }
  async recordPoints(pools: PoolMetrics[]) {
    this.recorded.push(...pools.map((pool) => pool.poolAddress));
    return pools.length;
  }
  async deactivateExpired() {
    return this.expired;
  }
  async computeDueOutcomes() {
    return this.outcomes;
  }
  async stats() {
    return {
      trackedActive: 10,
      trackedTotal: 12,
      points: 5000,
      features: 1500,
      distinctCandidates: 1500,
      distinctPools: 500,
      outcomes: 3000,
      firstCaptureAt: new Date(T0.getTime() - 5 * 86_400_000),
      recordingDays: 5,
    };
  }
}

function deps(store: FakeStore, getPools?: TrackDeps["getPools"]): TrackDeps {
  return {
    store,
    getPools:
      getPools ??
      (async (addresses) => addresses.map((address) => buildPool({ poolAddress: address }))),
    now: () => T0,
  };
}

describe("runTrackCycle", () => {
  it("schreibt für jeden fälligen Pool einen Messpunkt", async () => {
    const store = new FakeStore();
    store.due = [
      { poolAddress: "PoolA", tokenMint: "MintA" },
      { poolAddress: "PoolB", tokenMint: "MintB" },
    ];

    const result = await runTrackCycle(deps(store));

    expect(result.recorded).toBe(2);
    expect(result.failed).toBe(0);
    expect(store.recorded).toEqual(["PoolA", "PoolB"]);
  });

  it("fragt alle fälligen Pools in einem Sammelabruf ab, nicht einzeln", async () => {
    // Das ist der Kern der Skalierung: Bei einigen tausend verfolgten Pools
    // reicht kein Messraster für eine Anfrage je Pool.
    const store = new FakeStore();
    store.due = Array.from({ length: 500 }, (_, i) => ({
      poolAddress: `Pool${i}`,
      tokenMint: `Mint${i}`,
    }));

    const batches: number[] = [];
    const result = await runTrackCycle(
      deps(store, async (addresses) => {
        batches.push(addresses.length);
        return addresses.map((address) => buildPool({ poolAddress: address }));
      }),
    );

    expect(batches).toEqual([500]);
    expect(result.recorded).toBe(500);
  });

  it("weist Pools aus, für die die Antwort keinen Wert enthielt", async () => {
    // Ein entfernter oder blacklisteter Pool fehlt einfach im Sammelergebnis.
    // Das darf nicht unsichtbar bleiben — so sieht eine verarmende
    // Aufzeichnung aus.
    const store = new FakeStore();
    store.due = [
      { poolAddress: "PoolA", tokenMint: "MintA" },
      { poolAddress: "Verschwunden", tokenMint: "MintB" },
      { poolAddress: "PoolC", tokenMint: "MintC" },
    ];

    const result = await runTrackCycle(
      deps(store, async (addresses) =>
        addresses
          .filter((address) => address !== "Verschwunden")
          .map((address) => buildPool({ poolAddress: address })),
      ),
    );

    expect(result.recorded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.notes.join(" ")).toContain("Verschwunden");
  });

  it("ein fehlgeschlagener Sammelabruf trifft die Runde, nicht den Bestand", async () => {
    const store = new FakeStore();
    store.due = Array.from({ length: 20 }, (_, i) => ({
      poolAddress: `Pool${i}`,
      tokenMint: `Mint${i}`,
    }));

    const result = await runTrackCycle(
      deps(store, async () => {
        throw new Error("API weg");
      }),
    );

    // Die Runde ist beim nächsten Durchgang unverändert fällig — der Fehler
    // kostet also nur diesen Durchgang.
    expect(result.failed).toBe(20);
    expect(result.recorded).toBe(0);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain("Sammelabruf");
  });

  it("beendet abgelaufene Verfolgungen und berechnet fällige Labels", async () => {
    const store = new FakeStore();
    store.expired = 3;
    store.outcomes = 12;
    const result = await runTrackCycle(deps(store));
    expect(result.expired).toBe(3);
    expect(result.outcomes).toBe(12);
  });
});

describe("formatTrackStatus", () => {
  const base = {
    trackedActive: 10,
    trackedTotal: 12,
    points: 5000,
    features: 1500,
    distinctCandidates: 1500,
    distinctPools: 500,
    outcomes: 3000,
    firstCaptureAt: new Date(T0.getTime() - 5 * 86_400_000),
    recordingDays: 5,
  };

  it("schätzt die Restdauer aus der tatsächlichen Sammelrate", () => {
    // 1500 verschiedene Kandidaten in 5 Tagen = 300/Tag → 1500 fehlende ≈ 5 Tage
    const text = formatTrackStatus(base, 3000);
    expect(text).toContain("300 neue Kandidaten/Tag");
    expect(text).toContain("Noch ca. 5 Tage");
  });

  it("meldet das Erreichen der Zielmenge", () => {
    expect(formatTrackStatus({ ...base, distinctCandidates: 3500 }, 3000)).toContain("Zielmenge");
  });

  it("hält sich bei zu kurzer Laufzeit mit Schätzungen zurück", () => {
    const text = formatTrackStatus({ ...base, recordingDays: 0.2 }, 3000);
    expect(text).toContain("zu früh");
    expect(text).not.toContain("Noch ca.");
  });

  it("warnt bei Aufzeichnungslücken", () => {
    // Erwartet würden ~12 Pools × 5 Tage × 24 h = 1440 Punkte; 100 sind zu wenig.
    const text = formatTrackStatus({ ...base, points: 100 }, 3000);
    expect(text).toContain("Ruhezustand");
  });

  it("meldet Stillstand, wenn nichts mehr dazukommt", () => {
    const text = formatTrackStatus(
      { ...base, features: 0, distinctCandidates: 0, distinctPools: 0 },
      3000,
    );
    expect(text).toContain("läuft der Scan");
  });

  it("zählt Wiederholungen nicht als eigene Beobachtungen", () => {
    // Der reale Fall: 34 Pools, stündlich neu erfasst. Wer Zeilen zählt, sieht
    // scheinbaren Fortschritt, obwohl die Breite des Datensatzes stillsteht.
    const text = formatTrackStatus(
      { ...base, features: 1298, distinctCandidates: 102, distinctPools: 34, recordingDays: 0.5 },
      3000,
    );
    expect(text).toContain("102 verschiedene Kandidaten");
    expect(text).toContain("34 Pools");
    // Die Zeilenzahl bleibt sichtbar, aber als Wiederholung ausgewiesen.
    expect(text).toContain("1298 Merkmalszeilen");
    expect(text).toContain("12.7× erfasst");
  });

  it("warnt, wenn die Suche zu wenige verschiedene Pools sieht", () => {
    const narrow = formatTrackStatus(
      { ...base, distinctCandidates: 100, distinctPools: 34, recordingDays: 5 },
      3000,
    );
    // 20 neue Kandidaten/Tag: längeres Warten verlängert nur die Zeitreihen.
    expect(narrow).toContain("zu wenige");
    expect(narrow).toContain("TOP=");

    // Bei ausreichender Breite bleibt die Anzeige ruhig.
    expect(formatTrackStatus(base, 3000)).not.toContain("zu wenige");
  });
});

describe("formatFeatureVersions", () => {
  const row = (featureVersion: number, count: number, first: string, last: string) => ({
    featureVersion,
    count,
    firstAt: new Date(first),
    lastAt: new Date(last),
  });

  it("bleibt knapp, wenn nur ein Schema vorliegt", () => {
    const text = formatFeatureVersions([row(2, 1500, "2026-07-01", "2026-07-29")]);
    expect(text).toContain("v2");
    expect(text).toContain("1500");
    expect(text).not.toContain("mehrere Versionen");
  });

  it("weist einen Versionswechsel mit Zeiträumen aus", () => {
    const text = formatFeatureVersions([
      row(1, 900, "2026-07-01", "2026-07-28"),
      row(2, 300, "2026-07-29", "2026-07-29"),
    ]);
    expect(text).toContain("mehrere Versionen");
    expect(text).toContain("v1: 900");
    expect(text).toContain("v2: 300");
    expect(text).toContain("2026-07-28");
    // Die jüngste Version ist die Empfehlung für die Optimierung.
    expect(text).toContain("jüngste: v2");
  });

  it("meldet einen leeren Datensatz statt einer leeren Tabelle", () => {
    expect(formatFeatureVersions([])).toContain("noch keine Aufzeichnungen");
  });
});
