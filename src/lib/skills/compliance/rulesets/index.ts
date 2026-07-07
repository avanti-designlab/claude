/**
 * Seed rulesets — the five hand-authored verticals (doc 02). A new vertical
 * (M1b Playbook Generator) means adding a module here or calling
 * `registerRuleset()` at runtime; the engine never changes.
 */

import type { VerticalRuleset } from "../types";
import { cannabisRuleset } from "./cannabis";
import { ecommerceRuleset } from "./ecommerce";
import { healthLifeInsuranceRuleset } from "./health-life-insurance";
import { realEstateRuleset } from "./real-estate";
import { restaurantsRuleset } from "./restaurants";

export { cannabisRuleset, ecommerceRuleset, healthLifeInsuranceRuleset, realEstateRuleset, restaurantsRuleset };

export const SEED_RULESETS: readonly VerticalRuleset[] = [
  cannabisRuleset,
  realEstateRuleset,
  restaurantsRuleset,
  healthLifeInsuranceRuleset,
  ecommerceRuleset,
];
