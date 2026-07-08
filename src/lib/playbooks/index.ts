/**
 * Seed playbooks (M1, doc 02) — the five hand-authored verticals.
 *
 * Each vertical is transcribed from doc 02 into a typed `Playbook` (status
 * "seed", version "1.0.0"). Only real-estate is switched into ACTIVE client use
 * for the Gate 1a validation pass (doc 02 §"Validation-first rollout"); the
 * others are loaded-but-dormant until the loop is proven on client zero.
 *
 * This is the stable import seam the onboarding UI + downstream skills
 * (aeo-audit, schema-generation, compliance-ruleset) build against.
 */

import type { Playbook, SeedVertical } from "@/lib/types/playbook";
import { cannabisPlaybook } from "./cannabis";
import { realEstatePlaybook } from "./real-estate";
import { restaurantsPlaybook } from "./restaurants";
import { healthLifeInsurancePlaybook } from "./health-life-insurance";
import { ecommercePlaybook } from "./ecommerce";

/** The five seed playbooks, keyed by vertical. */
export const SEED_PLAYBOOKS: Record<SeedVertical, Playbook> = {
  cannabis: cannabisPlaybook,
  "real-estate": realEstatePlaybook,
  restaurants: restaurantsPlaybook,
  "health-life-insurance": healthLifeInsurancePlaybook,
  ecommerce: ecommercePlaybook,
};

/** Verticals switched into active client use (Gate 1a: real estate first). */
export const ACTIVE_VERTICALS: SeedVertical[] = ["real-estate"];

export function getPlaybook(vertical: SeedVertical): Playbook | null {
  return SEED_PLAYBOOKS[vertical] ?? null;
}

export {
  cannabisPlaybook,
  realEstatePlaybook,
  restaurantsPlaybook,
  healthLifeInsurancePlaybook,
  ecommercePlaybook,
};
