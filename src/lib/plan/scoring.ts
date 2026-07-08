/**
 * Deterministic priority scoring + ordering for the plan generator (M1).
 *
 * `priorityScore` is the product of channel weight and an impact factor, so a
 * task's rank is dominated by WHERE the vertical builds authority
 * (channel_weighting) — never an even distribution. Sorting is fully
 * deterministic: same input → identical roadmap order.
 */

import type { ImpactLevel, RoadmapTask } from "@/lib/types/roadmap";

/** Impact → score factor (mirrors the aeo-audit rubric factor). */
export const IMPACT_FACTOR: Record<ImpactLevel, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** Impact → sort rank (critical first). */
export const IMPACT_RANK: Record<ImpactLevel, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** priorityScore = channel weight × impact factor × source multiplier (rounded). */
export function priorityScore(
  channelWeight: number,
  impact: ImpactLevel,
  sourceMultiplier = 1,
): number {
  return Math.round(channelWeight * IMPACT_FACTOR[impact] * sourceMultiplier);
}

/** Effort (1–5) from impact — used for audit-derived tasks. */
export function effortForImpact(impact: ImpactLevel): number {
  switch (impact) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

/**
 * Stable roadmap ordering: priorityScore desc → impact (critical first) →
 * module asc → id asc. Total order — no ties left to engine/insertion order.
 */
export function sortTasks(tasks: RoadmapTask[]): RoadmapTask[] {
  return [...tasks].sort(
    (a, b) =>
      b.priorityScore - a.priorityScore ||
      IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] ||
      (a.module < b.module ? -1 : a.module > b.module ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
