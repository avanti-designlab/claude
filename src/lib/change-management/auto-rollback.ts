/**
 * Auto-rollback evaluation (doc 04 §2 MONITOR → ROLLBACK; §5).
 *
 * "AUTO-rollback fires if a change correlates with a traffic/ranking/visibility
 * drop beyond threshold." Thresholds are configurable PER CLIENT
 * ({@link AutoRollbackPolicy}). This module is PURE and deterministic: given the
 * ingested signals + a client's policy it returns the threshold breaches — the
 * actual revert + status write is done by the ChangeManager (manager.ts), and
 * the alert is emitted through the injected {@link AlertSink} (M17 Alerting
 * consumes it later; we only expose the hook).
 *
 * No wall-clock: each signal carries `observedAt` (ISO), injected by the caller,
 * exactly as the plan generator injects `now` (src/lib/plan/index.ts).
 *
 * Sign convention (from `MonitoringSignal.deltaPct`): NEGATIVE is WORSE. A
 * signal breaches when `deltaPct <= -threshold` — i.e. the metric fell by at
 * least the client's configured drop percentage. Metrics with no configured
 * threshold are never evaluated.
 */

import type {
  AutoRollbackPolicy,
  MonitoringSignal,
  ThresholdBreach,
} from "./types";

/** True when a single signal breaches its metric's configured threshold. */
export function isBreach(
  signal: MonitoringSignal,
  policy: AutoRollbackPolicy,
): boolean {
  const threshold = policy.thresholds[signal.metric];
  if (threshold === undefined || !Number.isFinite(threshold) || threshold <= 0) {
    return false;
  }
  if (!Number.isFinite(signal.deltaPct)) return false;
  return signal.deltaPct <= -threshold;
}

/**
 * All threshold breaches across a batch of ingested signals, worst first
 * (most-negative `deltaPct`). Pure — same signals + policy → same breaches,
 * in the same order (ties broken by metric name for determinism).
 */
export function evaluateBreaches(
  signals: readonly MonitoringSignal[],
  policy: AutoRollbackPolicy,
): ThresholdBreach[] {
  const breaches: ThresholdBreach[] = [];
  for (const signal of signals) {
    if (!isBreach(signal, policy)) continue;
    const threshold = policy.thresholds[signal.metric];
    // Narrowed non-undefined by isBreach; assert for the type checker.
    if (threshold === undefined) continue;
    breaches.push({
      metric: signal.metric,
      deltaPct: signal.deltaPct,
      threshold,
      signal,
    });
  }
  breaches.sort((a, b) => {
    if (a.deltaPct !== b.deltaPct) return a.deltaPct - b.deltaPct; // most negative first
    return a.metric.localeCompare(b.metric);
  });
  return breaches;
}

/** One human sentence per breach, e.g. `visibility -34% breaches 30% threshold`. */
export function describeBreach(breach: ThresholdBreach): string {
  const window =
    breach.signal.windowDays !== undefined
      ? ` over ${breach.signal.windowDays}d`
      : "";
  return `${breach.metric} ${breach.deltaPct}%${window} breaches the ${breach.threshold}% drop threshold`;
}

/**
 * The `site_changes.reverted_reason` recorded when auto-rollback executes.
 * Built from the worst breach + a count of the rest — deterministic, no clock.
 */
export function autoRollbackReason(breaches: readonly ThresholdBreach[]): string {
  if (breaches.length === 0) return "auto-rollback: no breach"; // defensive; caller guards
  const worst = breaches[0];
  const more =
    breaches.length > 1
      ? ` (+${breaches.length - 1} more metric${breaches.length - 1 === 1 ? "" : "s"})`
      : "";
  return `auto-rollback: ${describeBreach(worst)}${more}`;
}
