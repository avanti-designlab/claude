/**
 * M17 — pure evaluation: a measured SignalBundle → the `alerts` rows it
 * warrants. This is the "unify signal → alert" seam. PURE + deterministic.
 *
 * ── HONESTY ─────────────────────────────────────────────────────────────────
 * The evaluator only ever looks at signals the bundle actually CARRIES. A source
 * that produced no measured signal simply isn't in the bundle, so it contributes
 * zero rows — an absent signal is `unknown`, never a fabricated alert. Each rule
 * additionally returns null below its fire threshold. There is no path that
 * mints an alert from missing data.
 *
 * ── NO DOUBLE-WRITE ─────────────────────────────────────────────────────────
 * The bundle CANNOT carry `crawler_blocked` (M5) or `auto_rollback_fired`
 * (change-management) signals — those fields don't exist on SignalBundle
 * (types.ts). So the evaluator structurally cannot re-derive another owner's
 * class; every row it emits is one of M17's five writer types.
 */

import {
  competitorOvertookRule,
  reviewSpikeRule,
  schemaBrokeRule,
  siteDownRule,
  visibilityDropRule,
} from "./rules";
import type { AlertInsertRow } from "./rows";
import type { AlertScope, SignalBundle } from "./types";

/**
 * Evaluate every measured signal in `bundle` into candidate `alerts` rows.
 * Order is deterministic: visibility → competitors → schema → reviews → site,
 * preserving each list's input order. Dedup + persistence is persist.ts's job;
 * this stage is pure.
 */
export function evaluateSignals(scope: AlertScope, bundle: SignalBundle): AlertInsertRow[] {
  const rows: AlertInsertRow[] = [];

  if (bundle.visibilityDrop) {
    const row = visibilityDropRule(scope, bundle.visibilityDrop);
    if (row) rows.push(row);
  }

  for (const signal of bundle.competitorOvertook ?? []) {
    const row = competitorOvertookRule(scope, signal);
    if (row) rows.push(row);
  }

  for (const signal of bundle.schemaBroke ?? []) {
    rows.push(schemaBrokeRule(scope, signal));
  }

  for (const signal of bundle.reviewSpike ?? []) {
    const row = reviewSpikeRule(scope, signal);
    if (row) rows.push(row);
  }

  for (const signal of bundle.siteDown ?? []) {
    const row = siteDownRule(scope, signal);
    if (row) rows.push(row);
  }

  return rows;
}
