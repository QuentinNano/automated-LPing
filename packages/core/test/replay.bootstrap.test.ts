import { describe, expect, it } from "vitest";
import { clusterBootstrapCI, groupBy } from "@lping/core";

/** Median einer Zahlenreihe — die Statistik, an der die Intervalle hängen. */
function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

describe("groupBy", () => {
  it("gruppiert in der Reihenfolge des ersten Auftretens", () => {
    const groups = groupBy(
      [
        { pool: "b", v: 1 },
        { pool: "a", v: 2 },
        { pool: "b", v: 3 },
      ],
      (item) => item.pool,
    );
    expect(groups.map((group) => group.map((item) => item.v))).toEqual([[1, 3], [2]]);
  });
});

describe("clusterBootstrapCI", () => {
  it("liefert kein Intervall aus weniger als zwei Clustern", () => {
    // Aus einer einzigen Gruppe lässt sich die Streuung zwischen Gruppen nicht
    // schätzen — ein Intervall daraus wäre eine Aussage über nichts.
    expect(clusterBootstrapCI([[1, 2, 3]], median)).toBeNull();
    expect(clusterBootstrapCI([], median)).toBeNull();
  });

  it("schließt den wahren Wert ein und ist nach Konfidenz sortiert", () => {
    const clusters = [[1, 1, 1], [2, 2], [3, 3, 3], [4], [5, 5]];
    const ci = clusterBootstrapCI(clusters, median);
    expect(ci).not.toBeNull();
    expect(ci!.low).toBeLessThanOrEqual(ci!.high);
    expect(ci!.low).toBeLessThanOrEqual(3);
    expect(ci!.high).toBeGreaterThanOrEqual(3);
    expect(ci!.confidence).toBe(0.9);
  });

  it("ist deterministisch — gleicher Seed, gleiches Intervall", () => {
    const clusters = [[1, 5], [2, 9], [3], [7, 7]];
    const a = clusterBootstrapCI(clusters, median);
    const b = clusterBootstrapCI(clusters, median);
    expect(a).toEqual(b);

    // Ein anderer Seed darf ein anderes Intervall ergeben — sonst wäre der
    // Seed wirkungslos und der Bootstrap keiner.
    const c = clusterBootstrapCI(clusters, median, { seed: 12345, resamples: 500 });
    expect(c).not.toEqual(a);
  });

  it("zeigt bei überlappenden Beobachtungen die Streuung der POOLS, nicht der Zeilen", () => {
    // Der Kern der Sache: 300 Beobachtungen aus drei Pools, innerhalb eines
    // Pools identisch. Ein naiver Bootstrap über Zeilen fände ein sehr enges
    // Intervall — tatsächlich stecken darin drei Beobachtungen.
    const clusters = [
      Array.from({ length: 100 }, () => 10),
      Array.from({ length: 100 }, () => 20),
      Array.from({ length: 100 }, () => 30),
    ];
    const clustered = clusterBootstrapCI(clusters, median)!;
    const naive = clusterBootstrapCI(
      clusters.flat().map((value) => [value]),
      median,
    )!;

    expect(clustered.high - clustered.low).toBeGreaterThan(naive.high - naive.low);
  });

  it("überspringt leere Cluster, statt sie als Beobachtung zu zählen", () => {
    const withEmpty = clusterBootstrapCI([[1, 2], [], [3, 4]], median);
    const without = clusterBootstrapCI([[1, 2], [3, 4]], median);
    expect(withEmpty).toEqual(without);
  });
});
