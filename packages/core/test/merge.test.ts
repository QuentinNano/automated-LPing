import { describe, expect, it } from "vitest";
import { deepMerge } from "@lping/core";

describe("deepMerge", () => {
  it("merged verschachtelte Objekte und ersetzt Primitive", () => {
    const base = { a: { b: 1, c: 2 }, d: 3 };
    expect(deepMerge(base, { a: { b: 9 } })).toEqual({ a: { b: 9, c: 2 }, d: 3 });
  });

  it("lässt undefined unangetastet, setzt null explizit", () => {
    const base = { a: 1, b: 2 };
    expect(deepMerge(base, { a: undefined, b: null })).toEqual({ a: 1, b: null });
  });

  it("ersetzt Arrays statt sie zu mergen", () => {
    expect(deepMerge({ a: [1, 2, 3] }, { a: [9] })).toEqual({ a: [9] });
  });

  it("mutiert die Basis nicht", () => {
    const base = { a: { b: 1 } };
    deepMerge(base, { a: { b: 2 } });
    expect(base.a.b).toBe(1);
  });
});
