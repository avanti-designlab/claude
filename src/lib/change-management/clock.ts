/**
 * Clock implementations (doc: determinism — no wall-clock in decision logic).
 *
 * `systemClock` is the ONLY wall-clock reader and is meant to be injected at the
 * app edge (route handler / job runner), never called from decision logic. The
 * deterministic clocks make the whole pipeline reproducible in tests, exactly as
 * the plan generator takes an injected `now` (src/lib/plan/index.ts).
 */

import type { Clock } from "./ports";

/** Production edge clock. Inject this where the app meets the outside world. */
export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

/** Always returns the same instant — the simplest deterministic clock. */
export function fixedClock(iso: string): Clock {
  return { now: () => iso };
}

/**
 * Advances by `stepMs` on every `now()` call, starting at `startIso`. Gives
 * each pipeline step a distinct, ordered, fully-deterministic timestamp.
 */
export function steppingClock(startIso: string, stepMs = 1000): Clock {
  let t = new Date(startIso).getTime();
  let first = true;
  return {
    now: () => {
      if (first) {
        first = false;
      } else {
        t += stepMs;
      }
      return new Date(t).toISOString();
    },
  };
}
