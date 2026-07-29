import { describe, expect, it } from "vitest";
import { formEntriesToPatch } from "../src/lib/formPatch";

function entries(pairs: Record<string, string>): [string, FormDataEntryValue][] {
  return Object.entries(pairs);
}

describe("formEntriesToPatch", () => {
  it("faltet Pfade zu einem verschachtelten Patch auf", () => {
    const result = formEntriesToPatch(
      entries({
        "global.maxTotalExposureSol|number": "25",
        "presets.degen.stopLossPct|number": "12",
        "presets.degen.strategy.type|string": "Curve",
        "presets.konservativ.enabled|bool": "false",
      }),
    );
    expect(result).toEqual({
      ok: true,
      patch: {
        global: { maxTotalExposureSol: 25 },
        presets: {
          degen: { stopLossPct: 12, strategy: { type: "Curve" } },
          konservativ: { enabled: false },
        },
      },
    });
  });

  it("ignoriert Next.js-interne Felder von Server Actions", () => {
    const result = formEntriesToPatch(
      entries({ $ACTION_REF_1: "x", "$ACTION_1:0": "y", "global.minSolReserve|number": "1" }),
    );
    expect(result).toEqual({ ok: true, patch: { global: { minSolReserve: 1 } } });
  });

  it("meldet ungültige Zahlen mit Feldbezug statt sie zu verschlucken", () => {
    const result = formEntriesToPatch(entries({ "global.minSolReserve|number": "abc" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("global.minSolReserve");
      expect(result.error).toContain("keine gültige Zahl");
    }
  });

  it("überspringt leere Zahlenfelder, statt sie auf 0 zu setzen", () => {
    const result = formEntriesToPatch(
      entries({ "presets.degen.takeProfitPct|number": "  ", "presets.degen.stopLossPct|number": "20" }),
    );
    expect(result).toEqual({ ok: true, patch: { presets: { degen: { stopLossPct: 20 } } } });
  });

  it("wandelt bool-Felder korrekt in echte Booleans", () => {
    const result = formEntriesToPatch(
      entries({ "global.paperTrading|bool": "true", "presets.degen.rebalance.enabled|bool": "false" }),
    );
    expect(result).toEqual({
      ok: true,
      patch: {
        global: { paperTrading: true },
        presets: { degen: { rebalance: { enabled: false } } },
      },
    });
  });

  it("ignoriert Felder ohne Typ-Suffix oder mit unbekanntem Typ", () => {
    const result = formEntriesToPatch(
      entries({ ohneSuffix: "x", "global.foo|weirdtype": "y", "global.minSolReserve|number": "1" }),
    );
    expect(result).toEqual({ ok: true, patch: { global: { minSolReserve: 1 } } });
  });
});
