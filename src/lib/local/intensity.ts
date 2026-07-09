/**
 * M14 Local SEO — playbook-driven intensity (doc 05 M14, doc 07 §1.6).
 *
 * How aggressively the local module runs is NEVER invented — it is read from
 * the loaded vertical playbook. Two playbook fields carry the signal and this
 * module reads BOTH:
 *   - `local_intensity` (hyper-local | semi-local | national) — the coarse dial;
 *   - `local_module_config.gbp_priority` (critical | high | medium | off) — the
 *     playbook's own fine-grained local dial, used to split hyper-local into
 *     CRITICAL vs HIGH.
 *
 * Mapping (task + doc 05 M14 "CRITICAL for restaurants/cannabis, MEDIUM for
 * real-estate/insurance, OFF for e-commerce"):
 *   national OR module disabled → OFF
 *   semi-local                  → MEDIUM   (real-estate, insurance)
 *   hyper-local                 → CRITICAL when gbp_priority === "critical"
 *                                 (restaurants), else HIGH (cannabis, gbp
 *                                 priority "high")
 *
 * doc 05's prose lumps restaurants + cannabis as "CRITICAL"; the playbook DATA
 * grades them finer (restaurants gbp_priority "critical", cannabis "high"), and
 * this module is faithful to the data, not the prose. Generated playbooks (M1b)
 * follow the same schema, so this mapping applies to them unchanged.
 */

import type { ImpactLevel } from "@/lib/skills/aeo-audit";
import type { Playbook } from "@/lib/types/playbook";

/**
 * M14/M15 operational intensity — a DISTINCT enum from the playbook's
 * `LocalIntensity` (hyper-local | semi-local | national). It expresses how hard
 * the local module runs, graded to line up with `gbp_priority`.
 */
export type LocalIntensityLevel = "critical" | "high" | "medium" | "off";

/** Read the M14 intensity straight from the loaded playbook — never invented. */
export function localIntensity(playbook: Playbook): LocalIntensityLevel {
  const cfg = playbook.local_module_config;
  // A disabled local module is OFF regardless of intensity (generated playbooks
  // could set enabled:false with any intensity — respect it).
  if (!cfg.enabled) return "off";
  switch (playbook.local_intensity) {
    case "national":
      return "off";
    case "semi-local":
      return "medium";
    case "hyper-local":
      // Split by the playbook's own GBP priority (restaurants "critical" →
      // critical; cannabis "high" → high). Any other value falls back to HIGH —
      // hyper-local is at minimum HIGH, never lower.
      return cfg.gbp_priority === "critical" ? "critical" : "high";
    default:
      // Unknown intensity from a generated playbook: derive from gbp_priority
      // (its own graded dial) rather than inventing a level.
      return cfg.gbp_priority === "off" ? "off" : cfg.gbp_priority;
  }
}

/** True when the local module is OFF for this playbook (national / disabled). */
export function isLocalOff(playbook: Playbook): boolean {
  return localIntensity(playbook) === "off";
}

/**
 * The impact level a local finding carries at this intensity — never harder
 * than the vertical's own local importance. Drives FixDraft.impact so that a
 * restaurant NAP mismatch outranks a real-estate one at the plan-merge seam,
 * exactly as the playbook weighting intends.
 */
export function impactForIntensity(level: LocalIntensityLevel): ImpactLevel {
  switch (level) {
    case "critical":
      return "critical";
    case "high":
      return "high";
    case "medium":
      return "medium";
    case "off":
      return "low";
  }
}
