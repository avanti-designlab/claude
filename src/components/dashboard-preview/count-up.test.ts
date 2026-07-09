/**
 * Run-planning contract for the count-up primitive (design review,
 * 2026-07-09, Minor 6). `countUpRun` is the pure decision inside
 * `useCountUp`; this suite pins:
 *
 *  - FIRST mount is byte-identical to the approved preview choreography:
 *    from 0, holding through the entrance delay (`counterDelayMs`);
 *  - a strict-mode effect replay (same target again) still counts as the
 *    first mount — never a delay-skipping "retarget" in dev;
 *  - a RETARGET (router.refresh() reconciled a new value into a live
 *    component) animates from the value already on screen with NO delay —
 *    no momentary false zero, no dead air.
 *
 * Reduced motion never reaches this decision: `useCountUp` returns the final
 * target directly (pinned by the moments library's reduced-motion suite).
 */

import { describe, expect, it } from "vitest";
import { countUpRun } from "./count-up";

describe("countUpRun", () => {
  it("first mount (no previous run): from 0, holding through the entrance delay", () => {
    expect(countUpRun(null, 34, 0, 640)).toEqual({ from: 0, delayMs: 640 });
    expect(countUpRun(null, 34, 0, 0)).toEqual({ from: 0, delayMs: 0 });
  });

  it("a strict-mode replay of the SAME target resolves as first mount (delay kept)", () => {
    // React 18 dev strict mode re-runs the effect with prevTarget already
    // recorded; the target has not changed, so the choreography must not.
    expect(countUpRun(34, 34, 34, 640)).toEqual({ from: 0, delayMs: 640 });
  });

  it("a retarget animates from the value on screen, with no delay", () => {
    // Settled: the screen shows the old target.
    expect(countUpRun(3, 4, 3, 640)).toEqual({ from: 3, delayMs: 0 });
    // Mid-flight: the screen shows a partial value — start exactly there.
    expect(countUpRun(10, 20, 6.5, 640)).toEqual({ from: 6.5, delayMs: 0 });
  });

  it("a retarget can go down as well as up (counts shrink too)", () => {
    expect(countUpRun(12, 9, 12, 300)).toEqual({ from: 12, delayMs: 0 });
  });

  it("a negative entrance delay is clamped to zero", () => {
    expect(countUpRun(null, 5, 0, -100)).toEqual({ from: 0, delayMs: 0 });
  });
});
