/**
 * M14 Local SEO — M14-owned fix builders (doc 05 M14; task deliverable 4).
 *
 * Every local finding becomes a `FixDraft` in the SKILL's shape (module M14,
 * a valid CheckId), so the fixes flow through the EXISTING audit-merge seam
 * (`localPlanInput` → generatePlan) with no parallel plan logic — exactly how
 * M6 (decay) and M4 (competitor) project their fixes. Priority is assigned at
 * the plan-merge seam by the playbook-aware generator, never here.
 *
 * Impact is graded by the playbook's own intensity (`impactForIntensity`) so a
 * restaurant NAP mismatch outranks a real-estate one — never invented.
 */

import type { FixDraft } from "@/lib/skills/aeo-audit";
import type { CanonicalLocation } from "./locations";
import { impactForIntensity, type LocalIntensityLevel } from "./intensity";
import type { LocationSchemaOutcome } from "./schema";
import type { LocalPackAssessment, NapAssessment } from "./types";

/** Stable, deterministic per-location fix-id suffix. */
function locSlug(location: CanonicalLocation): string {
  const base = (location.name ?? `location-${location.index}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base || "location"}-${location.index}`;
}

/** On-site NAP fixes: correct mismatched schema, or add absent NAP to the site. */
export function napFixes(
  location: CanonicalLocation,
  nap: NapAssessment,
  intensity: LocalIntensityLevel,
): FixDraft[] {
  if (!nap.assessable) return []; // site uncrawlable — no honest on-site fix to raise
  const slug = locSlug(location);
  const label = location.name ?? `location #${location.index + 1}`;
  const impact = impactForIntensity(intensity);
  const fixes: FixDraft[] = [];

  const mismatched = nap.fields.filter((f) => f.status === "mismatch");
  if (mismatched.length > 0) {
    fixes.push({
      id: `local/nap-onsite-mismatch-${slug}`,
      checkId: "nap_consistency",
      title: `Correct on-site NAP for "${label}" (${mismatched.map((f) => f.field).join(", ")})`,
      detail:
        `The site's local schema disagrees with the canonical record for ${mismatched
          .map((f) => `${f.field} (site: "${f.foundOnSite ?? ""}" vs canonical: "${f.canonical ?? ""}")`)
          .join("; ")}. ` +
        "Inconsistent on-site NAP erodes entity confidence across AI engines — we draft the corrections for your approval.",
      targetUrls: [],
      impact,
      impactEstimate:
        "Inconsistent NAP between the page and the canonical record weakens local entity resolution and 'near me' answers.",
      module: "M14",
      automationLevel: "ai_draft_human_approve",
    });
  }

  const absent = nap.fields.filter((f) => f.status === "absent");
  if (absent.length > 0) {
    fixes.push({
      id: `local/nap-onsite-absent-${slug}`,
      checkId: "nap_consistency",
      title: `Surface "${label}" NAP on the site (${absent.map((f) => f.field).join(", ")})`,
      detail:
        `The canonical ${absent.map((f) => f.field).join(", ")} for this location appears nowhere on the crawled site. ` +
        "Add the name, address, and phone as visible text (and matching local schema) so engines can resolve the location.",
      targetUrls: [],
      impact,
      impactEstimate: "Missing on-site NAP means engines have no on-page anchor for this location.",
      module: "M14",
      automationLevel: "ai_draft_human_approve",
    });
  }

  return fixes;
}

/**
 * Local-schema fixes: either the site should GAIN a valid local schema block,
 * or a required input (structured address) must be captured first.
 */
export function schemaFixes(
  outcome: LocationSchemaOutcome,
  location: CanonicalLocation,
  intensity: LocalIntensityLevel,
): FixDraft[] {
  const slug = locSlug(location);
  const label = location.name ?? `location #${location.index + 1}`;
  const impact = impactForIntensity(intensity);

  if (outcome.result === null) {
    // Skipped before generation — the input needed isn't available yet.
    return [
      {
        id: `local/local-schema-blocked-${slug}`,
        checkId: "schema_presence_validity",
        title: `Capture the data needed for "${label}" local schema`,
        detail: `Local schema can't be produced yet: ${outcome.reason}.`,
        targetUrls: [],
        impact,
        impactEstimate: "Local (LocalBusiness-class) schema is a primary local-pack + AI-answer signal for this vertical.",
        module: "M14",
        automationLevel: "human_only",
      },
    ];
  }

  if (outcome.result.status === "rejected") {
    // The NAP we'd assert isn't shown on the page — the visible-text gate blocked it.
    return [
      {
        id: `local/local-schema-mismatch-${slug}`,
        checkId: "schema_presence_validity",
        title: `Add on-page NAP so "${label}" local schema can be published`,
        detail:
          `The proposed ${outcome.schemaType} schema was rejected by the visible-text gate — it would assert facts the page does not show. ` +
          "Add the missing name/address/phone to the page's visible text, then the local schema can ship safely.",
        targetUrls: [],
        impact,
        impactEstimate: "Schema that doesn't match visible text is a manual-action risk — the gate blocks it until the page shows the facts.",
        module: "M14",
        automationLevel: "ai_draft_human_approve",
      },
    ];
  }

  // Ready — the site can gain (or refresh) a valid local schema block.
  return [
    {
      id: `local/local-schema-${slug}`,
      checkId: "schema_presence_validity",
      title: `Publish ${outcome.schemaType} schema for "${label}"`,
      detail:
        `A valid ${outcome.schemaType} JSON-LD block for this location matches the page's visible text and is ready for a diff-previewed, human-approved injection.`,
      targetUrls: [],
      impact,
      impactEstimate: "LocalBusiness-class schema is a primary local-pack and 'near me' AI-answer signal in this vertical.",
      module: "M14",
      automationLevel: "ai_draft_human_approve",
    },
  ];
}

/** A readiness fix when the location is scoped by ZIP but not fully local-pack ready. */
export function localPackFixes(
  location: CanonicalLocation,
  localPack: LocalPackAssessment,
  intensity: LocalIntensityLevel,
): FixDraft[] {
  if (localPack.readiness === "ready" || localPack.readiness === "not_assessable") return [];
  const slug = locSlug(location);
  const label = location.name ?? `location #${location.index + 1}`;
  return [
    {
      id: `local/local-pack-${slug}`,
      checkId: "gbp_completeness",
      title: `Close local-pack readiness gaps for "${label}" (ZIP ${localPack.zip})`,
      detail: `Local-pack readiness is ${localPack.readiness}. Signals: ${localPack.signals.join("; ")}.`,
      targetUrls: [],
      impact: impactForIntensity(intensity),
      impactEstimate: "Meeting the on-page + GBP preconditions is what qualifies the location for the local pack in this ZIP.",
      module: "M14",
      automationLevel: "ai_draft_human_approve",
    },
  ];
}
