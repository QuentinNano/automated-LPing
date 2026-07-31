import { describe, expect, it } from "vitest";
import { assessSize, assessSizes } from "@lping/core";
import { loadDefaultConfig } from "./builders";

const config = loadDefaultConfig();

describe("assessSizes", () => {
  it("meldet Presets, deren Positionsgröße die Fixkosten kaum trägt", () => {
    const warnings = assessSizes(config.presets, config.global);
    // Degen setzt 1 SOL: Eine einzelne Bin-Array-Initialisierung (~0,075 SOL)
    // ist dort 7,5 % des Einsatzes — über der 5-%-Grenze.
    expect(warnings.map((w) => w.preset)).toContain("degen");
    expect(warnings.every((w) => !w.viable)).toBe(true);
    expect(warnings[0]!.reason).toMatch(/Bin-Array|Fixkosten/);
  });

  it("übergeht deaktivierte Presets", () => {
    const presets = {
      ...config.presets,
      degen: { ...config.presets["degen"]!, enabled: false },
    };
    expect(assessSizes(presets, config.global).map((w) => w.preset)).not.toContain("degen");
  });

  it("schweigt, wenn die Größe die Kosten trägt", () => {
    const presets = { gross: { ...config.presets["degen"]!, positionSizeSol: 20 } };
    expect(assessSizes(presets, config.global)).toEqual([]);
    expect(assessSize(presets.gross, config.global).viable).toBe(true);
  });

  it("hängt an den globalen Kostenannahmen, nicht nur am Preset", () => {
    // Dieselbe Positionsgröße, teurere Priority Fees → nicht mehr tragfähig.
    const presets = { mittel: { ...config.presets["balanced"]!, positionSizeSol: 3 } };
    expect(assessSizes(presets, config.global)).toEqual([]);

    const teuer = {
      ...config.global,
      paper: {
        ...config.global.paper,
        costs: { ...config.global.paper.costs, priorityFeeSol: 0.05 },
      },
    };
    expect(assessSizes(presets, teuer).map((w) => w.preset)).toEqual(["mittel"]);
  });
});
