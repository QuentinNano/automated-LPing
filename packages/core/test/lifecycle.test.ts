import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  InvalidTransitionError,
  LIFECYCLE_STATES,
  TERMINAL_STATES,
  allowedTransitions,
} from "@lping/core";

describe("Positions-Lebenszyklus", () => {
  it("erlaubt die Übergänge aus dem Konzept-Diagramm (10.1)", () => {
    expect(canTransition("DISCOVERED", "REJECTED")).toBe(true);
    expect(canTransition("DISCOVERED", "QUEUED")).toBe(true);
    expect(canTransition("QUEUED", "OPENING")).toBe(true);
    expect(canTransition("OPENING", "ACTIVE")).toBe(true);
    expect(canTransition("OPENING", "FAILED")).toBe(true);
    expect(canTransition("ACTIVE", "REBALANCING")).toBe(true);
    expect(canTransition("REBALANCING", "ACTIVE")).toBe(true);
    expect(canTransition("REBALANCING", "CLOSING")).toBe(true);
    expect(canTransition("ACTIVE", "CLOSING")).toBe(true);
    expect(canTransition("CLOSING", "CLOSED")).toBe(true);
  });

  it("verbietet Abkürzungen und Rückwärtsbewegungen", () => {
    expect(canTransition("DISCOVERED", "ACTIVE")).toBe(false);
    expect(canTransition("ACTIVE", "OPENING")).toBe(false);
    expect(canTransition("CLOSING", "ACTIVE")).toBe(false);
    expect(() => assertTransition("QUEUED", "CLOSED")).toThrowError(InvalidTransitionError);
  });

  it("terminale Zustände haben keine Ausgänge", () => {
    expect([...TERMINAL_STATES].sort()).toEqual(["CLOSED", "FAILED", "REJECTED"]);
    for (const state of TERMINAL_STATES) {
      expect(allowedTransitions(state)).toEqual([]);
    }
  });

  it("jeder nicht-terminale Zustand erreicht einen terminalen Zustand", () => {
    for (const start of LIFECYCLE_STATES) {
      const seen = new Set<string>([start]);
      const queue = [start];
      let reachesTerminal = TERMINAL_STATES.has(start);
      while (queue.length > 0 && !reachesTerminal) {
        const next = allowedTransitions(queue.pop()!);
        for (const state of next) {
          if (TERMINAL_STATES.has(state)) reachesTerminal = true;
          if (!seen.has(state)) {
            seen.add(state);
            queue.push(state);
          }
        }
      }
      expect(reachesTerminal, `${start} muss terminal erreichbar sein`).toBe(true);
    }
  });
});
