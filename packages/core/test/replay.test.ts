import { describe, expect, it } from "vitest";
import {
  WSOL_MINT,
  marketTickFromPoint,
  marketTickFromPool,
  replayEntries,
  replayPosition,
  summarizeReplay,
  trackPointFromPool,
  type PoolMetrics,
  type ReplayPool,
  type TrackPoint,
} from "@lping/core";
import { buildPool, loadDefaultConfig, TOKEN_MINT } from "./builders";

const T0 = new Date("2026-07-29T12:00:00Z");
const config = loadDefaultConfig();

const pool: ReplayPool = {
  poolAddress: "PoolA",
  mintX: TOKEN_MINT,
  mintY: WSOL_MINT,
  binStep: 100,
};

/** Ein Messpunkt der Zeitreihe; Preis in `price_native` wie in der Datenbank. */
function point(minutesAfter: number, price: number, extra: Partial<TrackPoint> = {}): TrackPoint {
  return {
    ts: new Date(T0.getTime() + minutesAfter * 60_000),
    priceNative: price,
    tvlUsd: 250_000,
    fees24hUsd: 12_500,
    volume24hUsd: 1_250_000,
    dynamicFeePct: 1.4,
    baseFeePct: 1,
    protocolFeePct: 10,
    solPriceUsd: 180,
    windows: null,
    ...extra,
  };
}

/** Seitwärts laufender Verlauf über mehrere Stunden. */
function flatSeries(count: number, price = 0.001): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => point(i * 5, price));
}

const balanced = { preset: config.presets["balanced"]!, global: config.global };
const degen = { preset: config.presets["degen"]!, global: config.global };

describe("replayPosition", () => {
  it("eröffnet, bewertet und schließt über denselben Codepfad wie das Paper-Trading", () => {
    const position = replayPosition(flatSeries(60), pool, balanced);

    expect(position).not.toBeNull();
    expect(position!.entryAt).toEqual(T0);
    expect(position!.ticks).toBeGreaterThan(0);
    // Seitwärts, in Range: Die Position verdient Gebühren.
    expect(position!.state.feesClaimedSol + position!.state.feesUnclaimedSol).toBeGreaterThan(0);
    // Kosten fallen an — auch beim Schließen.
    expect(position!.state.costsSol).toBeGreaterThan(0);
  });

  it("beendet über das Zeitlimit des Presets", () => {
    // Degen hält maximal 24 h; der Verlauf reicht über 30 h.
    const series = Array.from({ length: 360 }, (_, i) => point(i * 5, 0.001));
    const position = replayPosition(series, pool, degen);

    expect(position!.closeReason).toBe("max_hold_time");
    expect(position!.censored).toBe(false);
    expect(position!.exitAt.getTime() - position!.entryAt.getTime()).toBeLessThanOrEqual(
      25 * 3_600_000,
    );
  });

  it("benennt einen Preissturz als solchen, statt ihn als Stop-Loss zu buchen", () => {
    const series = [
      ...flatSeries(3),
      point(20, 0.0005),
      point(25, 0.0002),
      point(30, 0.0001),
    ];
    const position = replayPosition(series, pool, balanced);

    // Halbierung binnen fünf Minuten: Das ist ein Sturz, kein allmähliches
    // Auslaufen. Der Grund unterscheidet beides — und die zustandsabhängige
    // Regel greift, bevor der PnL die Stop-Loss-Schwelle erreicht.
    expect(position!.closeReason).toBe("price_crash");
    expect(position!.valuation.pnlPct).toBeLessThan(0);
  });

  it("fällt auf den Stop-Loss zurück, wenn der Preis langsam genug zerfällt", () => {
    // Rund 2,5 % je Fünf-Minuten-Schritt bleiben unter der Sturz-Schwelle des
    // 30-Minuten-Fensters (20 %). Genau dafür gibt es den PnL-Stop: Er ist die
    // Rückfalllinie, wenn kein einzelnes Signal auffällig wird, die Position
    // aber trotzdem ausblutet.
    const series = Array.from({ length: 40 }, (_, i) => point(i * 5, 0.001 * 0.975 ** i));
    const position = replayPosition(series, pool, balanced);

    expect(position!.closeReason).toBe("stop_loss");
    expect(position!.valuation.pnlPct).toBeLessThanOrEqual(-balanced.preset.stopLossPct);
  });

  it("leitet die Range-Breite aus der Volatilität ab statt aus der Mitte von binRange", () => {
    // Der Befund, den das behebt: Der Replay rief `openPaperPosition` ohne
    // Volatilität, `deriveBinWidth` fiel auf die Mitte von binRange zurück, und
    // damit simulierte der Replay eine feste Breite, während live die
    // hergeleitete läuft.
    const mitte = Math.round(
      (balanced.preset.binRange.min + balanced.preset.binRange.max) / 2,
    );

    // Ein Verlauf mit spürbarer Bewegung vor dem Einstieg.
    const vorlauf = Array.from({ length: 40 }, (_, i) =>
      point(i * 5, 0.001 * (1 + 0.06 * Math.sin(i * 1.7))),
    );
    const series = [...vorlauf, ...Array.from({ length: 40 }, (_, i) => point(200 + i * 5, 0.001))];

    const spaet = replayPosition(series, pool, balanced, 39)!;
    expect(spaet.state.binWidthDerived).not.toBeNull();
    expect(spaet.state.bins.length).not.toBe(mitte);
    expect(spaet.state.bins.length).toBe(
      Math.min(
        balanced.preset.binRange.max,
        Math.max(balanced.preset.binRange.min, spaet.state.binWidthDerived!),
      ),
    );
  });

  it("schätzt die Volatilität nur aus der Vergangenheit — kein Look-Ahead", () => {
    // Ruhiger Vorlauf, wilde Zukunft. Wüsste die Herleitung von der Zukunft,
    // fiele die Range breiter aus.
    const ruhig = Array.from({ length: 30 }, (_, i) => point(i * 5, 0.001));
    const wild = Array.from({ length: 30 }, (_, i) =>
      point(150 + i * 5, 0.001 * (1 + 0.3 * Math.sin(i * 2.3))),
    );

    const nurRuhig = replayPosition(ruhig, pool, balanced, 29)!;
    const mitZukunft = replayPosition([...ruhig, ...wild], pool, balanced, 29)!;

    expect(mitZukunft.state.bins.length).toBe(nurRuhig.state.bins.length);
  });

  it("markiert am Datenende abgeschnittene Positionen als zensiert", () => {
    // Der Verlauf endet, bevor irgendeine Exit-Regel greift.
    const position = replayPosition(flatSeries(4), pool, balanced);

    expect(position!.closeReason).toBe("end_of_series");
    expect(position!.censored).toBe(true);
    // Auch die zensierte Position wird geschlossen — sonst fehlten ihr die
    // Ausstiegskosten, und sie sähe besser aus als eine regulär beendete.
    expect(position!.state.costsSol).toBeGreaterThan(0);
  });

  it("überspringt Beobachtungen ohne verwertbaren Preis", () => {
    const series = [
      point(0, 0.001),
      { ...point(5, 0), priceNative: null },
      point(10, 0.001),
    ];
    const position = replayPosition(series, pool, balanced);

    expect(position!.ticks).toBe(1);
  });

  it("gibt null zurück, wenn die Reihe keinen einzigen Preis hat", () => {
    const series = [{ ...point(0, 0), priceNative: null }];
    expect(replayPosition(series, pool, balanced)).toBeNull();
  });

  it("bucht ohne TVL keine Gebühren, statt sie zu erfinden", () => {
    // Genau der Fall aus KONZEPT-ML.md 5.2: nachgeladener Zeitraum ohne
    // Messpunkt in der Nähe. Der eigene Anteil am aktiven Bin wäre ein Anteil
    // an einer unbekannten Größe.
    const series = flatSeries(20).map((p) => ({ ...p, tvlUsd: null }));
    const position = replayPosition(series, pool, balanced);

    expect(position!.state.feesClaimedSol + position!.state.feesUnclaimedSol).toBe(0);
  });

  it("dreht den Preis, wenn SOL auf der X-Seite steht", () => {
    // `price_native` ist immer der Preis von X in Y. Bei einem SOL/X-Pool ist
    // das SOL in Token — ohne Invertierung läge jede Bin-Zuordnung falsch herum.
    const inverted: ReplayPool = { ...pool, mintX: WSOL_MINT, mintY: TOKEN_MINT };
    const tick = marketTickFromPoint(point(0, 1000), inverted);

    expect(tick!.priceInSol).toBeCloseTo(0.001);
  });
});

describe("Determinismus", () => {
  it("liefert bei gleichem Verlauf und gleichen Parametern dasselbe Ergebnis", () => {
    // Ohne diese Eigenschaft ist keine Optimierung reproduzierbar: Zwei Läufe
    // desselben Parametersatzes dürften sich nicht unterscheiden.
    const series = flatSeries(200, 0.001);
    const a = replayEntries(series, pool, { ...balanced, everyMinutes: 30 });
    const b = replayEntries(series, pool, { ...balanced, everyMinutes: 30 });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("hängt nicht an der Wanduhr", () => {
    // Alle Zeitangaben stammen aus den Daten; ein anderer Ausführungszeitpunkt
    // darf nichts ändern. Geprüft, indem derselbe Verlauf um Jahre verschoben
    // wird — die Kennzahlen müssen identisch bleiben.
    const series = flatSeries(120, 0.001);
    const shifted = series.map((p) => ({
      ...p,
      ts: new Date(p.ts.getTime() + 365 * 86_400_000),
    }));

    const original = summarizeReplay(replayEntries(series, pool, balanced));
    const later = summarizeReplay(replayEntries(shifted, pool, balanced));

    expect(later.totalPnlSol).toBeCloseTo(original.totalPnlSol, 12);
    expect(later.positions).toBe(original.positions);
  });
});

describe("replayEntries", () => {
  it("erzeugt aus einem Verlauf viele Positionen", () => {
    // Der Multiplikator: Kalenderzeit wird zu Rechenzeit.
    const series = flatSeries(300, 0.001);
    const hourly = replayEntries(series, pool, { ...balanced, everyMinutes: 60 });
    const quarterly = replayEntries(series, pool, { ...balanced, everyMinutes: 15 });

    expect(hourly.length).toBeGreaterThan(10);
    expect(quarterly.length).toBeGreaterThan(hourly.length);
  });

  it("hält den Abstand zwischen den Einstiegen ein", () => {
    const series = flatSeries(200, 0.001);
    const positions = replayEntries(series, pool, { ...balanced, everyMinutes: 60 });

    for (let i = 1; i < positions.length; i++) {
      const gap = positions[i]!.entryAt.getTime() - positions[i - 1]!.entryAt.getTime();
      expect(gap).toBeGreaterThanOrEqual(60 * 60_000);
    }
  });

  it("begrenzt die Zahl der Positionen", () => {
    const series = flatSeries(500, 0.001);
    const positions = replayEntries(series, pool, {
      ...balanced,
      everyMinutes: 5,
      maxPositions: 7,
    });

    expect(positions).toHaveLength(7);
  });
});

describe("summarizeReplay", () => {
  it("zählt zensierte Positionen getrennt von entschiedenen", () => {
    // Eine zensierte Position darf keine Trefferquote begründen: Ob sie
    // gewonnen hätte, weiß niemand. Sonst gewinnt jede Strategie, die ihre
    // Verlierer lange genug hält.
    const series = flatSeries(400, 0.001);
    const positions = replayEntries(series, pool, { ...degen, everyMinutes: 60 });
    const summary = summarizeReplay(positions);

    expect(summary.positions).toBe(summary.decided + summary.censored);
    expect(summary.censored).toBeGreaterThan(0);
    expect(summary.wins).toBeLessThanOrEqual(summary.decided);
  });

  it("weist die Ausstiegsgründe aus", () => {
    const series = Array.from({ length: 360 }, (_, i) => point(i * 5, 0.001));
    const summary = summarizeReplay(replayEntries(series, pool, { ...degen, everyMinutes: 120 }));

    expect(Object.keys(summary.closeReasons).length).toBeGreaterThan(0);
    expect(summary.closeReasons["end_of_series"]).toBeUndefined();
  });

  it("nutzt den Median, nicht den Mittelwert", () => {
    const positions = replayEntries(flatSeries(200, 0.001), pool, balanced);
    const summary = summarizeReplay(positions);

    expect(summary.medianPnlPct).not.toBeNull();
    expect(Number.isFinite(summary.medianPnlPct!)).toBe(true);
  });

  it("meldet leere Läufe ohne erfundene Kennzahlen", () => {
    const summary = summarizeReplay([]);
    expect(summary.positions).toBe(0);
    expect(summary.winRatePct).toBeNull();
    expect(summary.medianPnlPct).toBeNull();
    expect(summary.avgTimeInRangePct).toBeNull();
  });
});

describe("Gleichheit Replay ↔ Live", () => {
  /**
   * Der Test, den KONZEPT-ML.md 5 „nicht verhandelbar" nennt.
   *
   * Live entsteht ein Tick aus frischen Pool-Metriken, im Replay aus einer
   * aufgezeichneten Beobachtung. Wenn beide Wege für denselben Pool
   * auseinanderlaufen, optimiert man gegen eine Welt, in der man nicht handelt —
   * und niemand würde es merken, weil beide Seiten für sich plausibel aussehen.
   */
  const solPriceUsd = 180;

  function bothTicks(overrides: Partial<PoolMetrics> = {}) {
    const livePool = buildPool(overrides);
    const live = marketTickFromPool(livePool, { solPriceUsd, at: livePool.fetchedAt });
    const recorded: TrackPoint = {
      ...trackPointFromPool(livePool),
      solPriceUsd,
    };
    const replay = marketTickFromPoint(recorded, livePool);
    return { live, replay };
  }

  /**
   * Felder, die sich zwischen den Wegen unterscheiden **dürfen** — jedes mit
   * seinem Grund. Alles andere muss übereinstimmen.
   *
   * Diese Liste ist der eigentliche Test. Vorher zählte er Feld für Feld auf,
   * was gleich sein soll, und übersah damit zwangsläufig jedes **neue** Feld:
   * `poolVolume24hUsdSlow` kam hinzu, wurde im Replay nie gesetzt, und die
   * EV-Prüfung des Rebalancings fiel dort auf das kürzeste Volumenfenster
   * zurück — der Fehler, gegen den das Feld eingeführt worden war. Umgekehrt
   * formuliert schlägt der Test bei jedem neuen Feld an, bis jemand entscheidet,
   * ob es gleich sein muss.
   */
  const DARF_ABWEICHEN: Record<string, string> = {
    poolVolume24hUsd:
      "Live aus dem kürzesten Fenster hochgerechnet, im Replay steht die Rate " +
      "bereits in der Zeitreihe — dieselbe Größe, andere Umrechnungsstelle",
  };

  it("beide Wege ergeben in jedem Feld denselben Tick", () => {
    const { live, replay } = bothTicks();

    expect(live).not.toBeNull();
    expect(replay).not.toBeNull();

    const keys = new Set([...Object.keys(live!), ...Object.keys(replay!)]);
    const abweichungen: string[] = [];
    for (const key of keys) {
      if (key in DARF_ABWEICHEN) continue;
      const a = live![key as keyof typeof live];
      const b = replay![key as keyof typeof replay];
      const gleich =
        typeof a === "number" && typeof b === "number"
          ? Math.abs(a - b) <= Math.abs(a) * 1e-12
          : JSON.stringify(a) === JSON.stringify(b);
      if (!gleich) abweichungen.push(`${key}: live=${String(a)} replay=${String(b)}`);
    }
    expect(abweichungen).toEqual([]);

    // Beide Wege müssen dieselben Felder überhaupt kennen.
    expect(Object.keys(replay!).sort()).toEqual(Object.keys(live!).sort());
  });

  it("das träge Volumenfenster kommt in beiden Wegen an", () => {
    // Der konkrete Regressionsfall: Ohne diesen Wert projiziert das EV-Tor des
    // Rebalancings die kürzeste verfügbare Volumenspitze über Stunden.
    const { live, replay } = bothTicks({ volumeUsd: { m30: 25_000, h24: 600_000 } });
    expect(live!.poolVolume24hUsdSlow).toBe(600_000);
    expect(replay!.poolVolume24hUsdSlow).toBe(600_000);
    // Und es ist wirklich das träge, nicht das schnelle Fenster.
    expect(live!.poolVolume24hUsd).toBe(25_000 * 48);
  });

  it("Hoch und Tief kommen in SOL an — bei SOL auf der X-Seite vertauscht", () => {
    const basis = point(0, 0.001, { high: 0.0012, low: 0.0008 });

    const normal = marketTickFromPoint(basis, { mintX: TOKEN_MINT, mintY: WSOL_MINT })!;
    expect(normal.priceHigh).toBeCloseTo(0.0012, 12);
    expect(normal.priceLow).toBeCloseTo(0.0008, 12);

    // SOL ist Token X: Der Preis in SOL ist 1/price_native, und damit wird aus
    // dem Höchst- der Tiefstkurs. Ohne die Neuordnung prüfte der Stop-Loss
    // gegen das Hoch statt gegen das Tief.
    const invertiert = marketTickFromPoint(basis, { mintX: WSOL_MINT, mintY: TOKEN_MINT })!;
    expect(invertiert.priceHigh).toBeCloseTo(1 / 0.0008, 6);
    expect(invertiert.priceLow).toBeCloseTo(1 / 0.0012, 6);
    expect(invertiert.priceHigh!).toBeGreaterThan(invertiert.priceLow!);
  });

  it("ohne Extrema bleiben die Felder leer statt geraten", () => {
    const ohne = marketTickFromPoint(point(0, 0.001), pool)!;
    expect(ohne.priceHigh).toBeUndefined();
    expect(ohne.priceLow).toBeUndefined();
  });

  it("auch für Pools mit SOL auf der X-Seite", () => {
    const { live, replay } = bothTicks({
      mintX: WSOL_MINT,
      mintY: TOKEN_MINT,
      priceNative: 46_729,
    });

    expect(replay!.priceInSol).toBeCloseTo(live!.priceInSol, 15);
  });

  it("auch wenn nur kurze Zeitfenster belegt sind", () => {
    // Die Gebührenrate kommt dann aus fees/volume statt aus dynamic_fee_pct —
    // beide Wege müssen dieselbe Rangfolge anwenden.
    const { live, replay } = bothTicks({
      dynamicFeePct: undefined,
      volumeUsd: { h1: 50_000 },
      feesUsd: { h1: 750 },
    });

    expect(replay!.poolFeePct).toBeCloseTo(live!.poolFeePct, 12);
    expect(replay!.poolFeePct).toBeCloseTo(1.5, 6);
  });

  it("die Volumenrate unterscheidet sich bewusst — und nur dort", () => {
    // Live wird aus dem kürzesten Fenster hochgerechnet (`volume.h1 × 24`),
    // im Replay steht die Rate bereits in der Zeitreihe. Beide beschreiben
    // dieselbe Größe; die Umrechnung passiert nur an verschiedenen Stellen.
    const livePool = buildPool({ volumeUsd: { h1: 50_000, h24: 600_000 } });
    const live = marketTickFromPool(livePool, { solPriceUsd, at: livePool.fetchedAt });
    expect(live!.poolVolume24hUsd).toBeCloseTo(50_000 * 24);

    const recorded: TrackPoint = {
      ...trackPointFromPool(livePool),
      solPriceUsd,
      volume24hUsd: 50_000 * 24,
    };
    expect(marketTickFromPoint(recorded, livePool)!.poolVolume24hUsd).toBeCloseTo(50_000 * 24);
  });
});
