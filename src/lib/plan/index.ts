/**
 * Plan generator (M1, doc 02 / doc 07 §1.1) — STUB pending 1.1 implementation.
 *
 * The aeo-seo-logic-engineer implements `generatePlan`: load a playbook, merge
 * with an optional audit result, and produce a prioritized, channel-weighted
 * roadmap. Pure and deterministic — the caller supplies `now` so output is
 * replayable (no wall-clock inside).
 *
 * This stub exists so the onboarding UI can build against a stable import seam
 * while the real generator is authored in parallel.
 */

import type { Playbook } from "@/lib/types/playbook";
import type { GeneratedRoadmap } from "@/lib/types/roadmap";

export interface GeneratePlanInput {
  playbook: Playbook;
  /** ISO timestamp for `generatedAt` (keeps the generator pure). */
  now: string;
  /** Optional audit result to merge (aeo-audit skill output). Absent = playbook-only plan. */
  audit?: unknown;
}

export function generatePlan(input: GeneratePlanInput): GeneratedRoadmap {
  // STUB — replaced by the real generator in 1.1.
  return {
    vertical: input.playbook.vertical,
    playbookVersion: input.playbook.version,
    generatedAt: input.now,
    channelAllocation: {},
    tasks: [],
    summary: "",
  };
}
