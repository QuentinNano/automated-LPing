import { describe, expect, it } from "vitest";
import { evaluateTrackHealth, overallHealth, type TrackHealthInput } from "@lping/core";

const NOW = new Date("2026-07-29T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** Eine rundum gesunde Aufzeichnung. */
function healthy(overrides: Partial<TrackHealthInput> = {}): TrackHealthInput {
  return {
    now: NOW,
    trackedActive: 120,
    newestPointAt: minutesAgo(6),
    pointsLastHour: 460,
    poolsWithPointLastHour: 115,
    featuresLast6h: 90,
    featuresTotal: 1400,
    outcomesTotal: 2600,
    oldestFeatureAt: hoursAgo(120),
    fieldCoverage: {
      tvl_usd: 1,
      token_age_hours: 0.85,
      risk_score: 0.78,
      roundtrip_loss_pct: 0.8,
      organic_score: 0.62,
    },
    largestGapMinutes: 20,
    expectedIntervalMin: 15,
    ...overrides,
  };
}

const byId = (input: TrackHealthInput) => new Map(evaluateTrackHealth(input).map((c) => [c.id, c]));

describe("evaluateTrackHealth", () => {
  it("bewertet eine gesunde Aufzeichnung durchgehend als ok", () => {
    const checks = evaluateTrackHealth(healthy());
    expect(overallHealth(checks)).toBe("ok");
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(checks.filter((c) => c.status === "warn")).toEqual([]);
  });

  it("erkennt eine stehengebliebene Aufzeichnung", () => {
    const checks = byId(healthy({ newestPointAt: hoursAgo(3) }));
    expect(checks.get("running")?.status).toBe("fail");
    expect(checks.get("running")?.hint).toContain("aufzeichnen");
  });

  it("erkennt, wenn noch nie etwas aufgezeichnet wurde", () => {
    const checks = byId(healthy({ newestPointAt: null }));
    expect(checks.get("running")?.status).toBe("fail");
    expect(checks.get("running")?.detail).toContain("kein einziger");
  });

  it("erkennt, dass keine Pools verfolgt werden", () => {
    const checks = byId(healthy({ trackedActive: 0 }));
    expect(checks.get("tracked")?.status).toBe("fail");
    expect(checks.get("tracked")?.hint).toContain("api:check");
  });

  it("unterscheidet 'noch nie etwas gefunden' von 'aktuell nichts Neues'", () => {
    // Noch nie etwas gefunden → schwerwiegend.
    expect(byId(healthy({ featuresLast6h: 0, featuresTotal: 0 })).get("discovery")?.status).toBe(
      "fail",
    );
    // Schon Daten vorhanden, gerade nichts Neues → nur ein Hinweis.
    expect(byId(healthy({ featuresLast6h: 0, featuresTotal: 500 })).get("discovery")?.status).toBe(
      "warn",
    );
  });

  it("bewertet die Abdeckung der verfolgten Pools abgestuft", () => {
    expect(byId(healthy({ poolsWithPointLastHour: 100 })).get("coverage")?.status).toBe("ok");
    expect(byId(healthy({ poolsWithPointLastHour: 60 })).get("coverage")?.status).toBe("warn");
    expect(byId(healthy({ poolsWithPointLastHour: 10 })).get("coverage")?.status).toBe("fail");
  });

  it("bewertet Lücken nach ihrer Länge", () => {
    expect(byId(healthy({ largestGapMinutes: 30 })).get("gaps")?.status).toBe("ok");
    expect(byId(healthy({ largestGapMinutes: 120 })).get("gaps")?.status).toBe("warn");
    // Eine Nacht im Ruhezustand — der Fall, der den Datensatz verzerrt.
    const overnight = byId(healthy({ largestGapMinutes: 480 })).get("gaps");
    expect(overnight?.status).toBe("fail");
    expect(overnight?.hint).toContain("verzerren");
  });

  it("meldet eine vollständig ausgefallene Datenquelle als Fehler", () => {
    const checks = byId(
      healthy({ fieldCoverage: { ...healthy().fieldCoverage, organic_score: 0 } }),
    );
    const check = checks.get("field_organic_score");
    expect(check?.status).toBe("fail");
    expect(check?.hint).toContain("liefert gar nichts");
  });

  it("meldet eine teilweise ausfallende Quelle nur als Hinweis", () => {
    const checks = byId(
      healthy({ fieldCoverage: { ...healthy().fieldCoverage, risk_score: 0.2 } }),
    );
    expect(checks.get("field_risk_score")?.status).toBe("warn");
  });

  it("verlangt keine Labels, solange der erste Horizont nicht verstrichen ist", () => {
    const checks = byId(healthy({ oldestFeatureAt: minutesAgo(30), outcomesTotal: 0 }));
    expect(checks.get("outcomes")?.status).toBe("info");
    expect(overallHealth(evaluateTrackHealth(healthy({ oldestFeatureAt: minutesAgo(30), outcomesTotal: 0 })))).toBe("ok");
  });

  it("meldet fehlende Labels, sobald genug Zeit vergangen ist", () => {
    const checks = byId(healthy({ oldestFeatureAt: hoursAgo(48), outcomesTotal: 0 }));
    expect(checks.get("outcomes")?.status).toBe("fail");
  });
});

describe("overallHealth", () => {
  it("der schlechteste Einzelbefund entscheidet", () => {
    expect(overallHealth([{ id: "a", label: "A", status: "ok", detail: "" }])).toBe("ok");
    expect(
      overallHealth([
        { id: "a", label: "A", status: "ok", detail: "" },
        { id: "b", label: "B", status: "warn", detail: "" },
      ]),
    ).toBe("warn");
    expect(
      overallHealth([
        { id: "a", label: "A", status: "warn", detail: "" },
        { id: "b", label: "B", status: "fail", detail: "" },
      ]),
    ).toBe("fail");
  });

  it("reine Hinweise gelten als in Ordnung", () => {
    expect(overallHealth([{ id: "a", label: "A", status: "info", detail: "" }])).toBe("ok");
  });
});

describe("Merkmalsschema v2 in der Aufzeichnung", () => {
  const withV2 = (overrides: Record<string, number>) =>
    byId(
      healthy({
        fieldCoverage: {
          ...healthy().fieldCoverage,
          dynamic_fee_pct: 0.95,
          fee_tvl_1h_pct: 0.9,
          ...overrides,
        },
      }),
    );

  it("bestätigt die neuen Felder, wenn sie ankommen", () => {
    const checks = withV2({});
    expect(checks.get("field_dynamic_fee_pct")?.status).toBe("ok");
    expect(checks.get("field_fee_tvl_1h_pct")?.status).toBe("ok");
  });

  it("verweist bei völligem Ausfall auf den Aufzeichner, nicht auf die API", () => {
    // Diese Felder stehen im selben Response wie die Pool-Kennzahlen. Wer bei
    // der API sucht, verliert Aufzeichnungszeit, die nicht nachholbar ist.
    const check = withV2({ dynamic_fee_pct: 0 }).get("field_dynamic_fee_pct");
    expect(check?.status).toBe("fail");
    expect(check?.hint).toContain("altem Code");
    expect(check?.hint).toContain("pnpm aufzeichnen");
    expect(check?.hint).not.toContain("API-Fehler");
  });

  it("erklärt Teilbelegung als Nachwirkung des Schema-Wechsels", () => {
    const check = withV2({ fee_tvl_1h_pct: 0.4 }).get("field_fee_tvl_1h_pct");
    expect(check?.status).toBe("warn");
    expect(check?.hint).toContain("Schema v1");
  });

  it("lässt die Diagnose der echten Quellen unverändert", () => {
    // Bei RugCheck & Co. bleibt der API-Hinweis richtig.
    const check = byId(
      healthy({ fieldCoverage: { ...healthy().fieldCoverage, risk_score: 0 } }),
    ).get("field_risk_score");
    expect(check?.hint).toContain("API-Fehler");
  });

  it("wertet fehlende v2-Angaben nicht als Fehler, solange sie unbekannt sind", () => {
    // Vor dem ersten v2-Zyklus liefert healthMetrics die Schlüssel gar nicht —
    // dann darf der Bericht nichts behaupten.
    const checks = byId(healthy());
    expect(checks.has("field_dynamic_fee_pct")).toBe(false);
    expect(overallHealth(evaluateTrackHealth(healthy()))).toBe("ok");
  });
});
