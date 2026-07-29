/**
 * Positions-Lebenszyklus gemäß KONZEPT.md Abschnitt 10.1.
 * Kandidaten durchlaufen DISCOVERED → REJECTED/QUEUED; Positionen
 * OPENING → … → CLOSED/FAILED. Jeder Übergang wird als PositionEvent
 * persistiert (Audit-Trail).
 */

export const LIFECYCLE_STATES = [
  "DISCOVERED",
  "REJECTED",
  "QUEUED",
  "OPENING",
  "ACTIVE",
  "REBALANCING",
  "CLOSING",
  "CLOSED",
  "FAILED",
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  DISCOVERED: ["REJECTED", "QUEUED"],
  QUEUED: ["OPENING"],
  OPENING: ["ACTIVE", "FAILED"],
  ACTIVE: ["REBALANCING", "CLOSING"],
  REBALANCING: ["ACTIVE", "CLOSING"],
  CLOSING: ["CLOSED"],
  REJECTED: [],
  CLOSED: [],
  FAILED: [],
};

export const TERMINAL_STATES: ReadonlySet<LifecycleState> = new Set(
  (Object.entries(TRANSITIONS) as [LifecycleState, readonly LifecycleState[]][])
    .filter(([, targets]) => targets.length === 0)
    .map(([state]) => state),
);

/** Wohldefinierte Auslöser für Zustandsübergänge (Event-Log/`position_events.trigger`). */
export const TRIGGERS = {
  FILTER_REJECTED: "filter_rejected",
  SCORE_TOO_LOW: "score_too_low",
  SCORE_PASSED: "score_passed",
  SLOT_ASSIGNED: "slot_assigned",
  TX_CONFIRMED: "tx_confirmed",
  TX_FAILED: "tx_failed",
  REBALANCE_TRIGGERED: "rebalance_triggered",
  REBALANCE_DONE: "rebalance_done",
  STOP_LOSS: "stop_loss",
  TAKE_PROFIT: "take_profit",
  MAX_HOLD_TIME: "max_hold_time",
  SCORE_DECAY: "score_decay",
  EMERGENCY: "emergency",
  KILL_SWITCH: "kill_switch",
  CLOSED_SETTLED: "closed_settled",
} as const;

export type TransitionTrigger = (typeof TRIGGERS)[keyof typeof TRIGGERS];

export function allowedTransitions(from: LifecycleState): readonly LifecycleState[] {
  return TRANSITIONS[from];
}

export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: LifecycleState,
    public readonly to: LifecycleState,
  ) {
    super(`Ungültiger Zustandsübergang: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: LifecycleState, to: LifecycleState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
