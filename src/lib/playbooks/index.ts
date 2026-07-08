/**
 * Seed playbooks (M1, doc 02) — STUB pending 1.1 implementation.
 *
 * The aeo-seo-logic-engineer fills this with the 5 hand-authored seed
 * playbooks (cannabis, real-estate, restaurants, health-life-insurance,
 * ecommerce). Only real-estate is switched into ACTIVE client use for the
 * Gate 1a validation pass; the others are loaded-but-dormant.
 *
 * This stub exists so the onboarding UI can build against a stable import
 * seam while the real data is authored in parallel.
 */

import type { Playbook, SeedVertical } from "@/lib/types/playbook";

/** Populated by 1.1. */
export const SEED_PLAYBOOKS: Record<SeedVertical, Playbook | null> = {
  cannabis: null,
  "real-estate": null,
  restaurants: null,
  "health-life-insurance": null,
  ecommerce: null,
};

/** Verticals switched into active client use (Gate 1a: real estate first). */
export const ACTIVE_VERTICALS: SeedVertical[] = ["real-estate"];

export function getPlaybook(vertical: SeedVertical): Playbook | null {
  return SEED_PLAYBOOKS[vertical];
}
