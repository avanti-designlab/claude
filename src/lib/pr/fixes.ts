/**
 * M12 PR entity-leverage — M12-owned fix builders (doc 05 M12; task deliverable 2).
 *
 * Every entity-authority finding becomes an {@link EntityFixDraft} (module "M12",
 * a valid roadmap ModuleRef with entity/offsite/podcast channel archetypes), so
 * the fixes flow through the EXISTING audit-merge seam (`entityPlanInput` →
 * generatePlan) with no parallel plan logic — exactly how M6 (decay), M4
 * (competitor), and M14 (local) project their fixes. Priority is assigned at the
 * plan-merge seam by the playbook-aware generator, never here.
 *
 * HONEST FIXES ONLY: M12 never raises a fix that asserts unearned authority. It
 * raises fixes to (a) publish entity schema that ALREADY matches the page, (b)
 * ADD the on-page facts a rejected schema needs before it can publish, (c) build
 * a press surface for press that is ALREADY corroborated on-page, and (d) surface
 * an uncorroborated publication ON the page (so a real press mention becomes
 * on-page authority) — it never fabricates the mention itself.
 */

import type { EntitySchemaOutcome } from "./entity-schema";
import type { EntityFixDraft, PersonEntityAssessment, PressSurfaceAssessment } from "./types";
import { M12_MODULE } from "./types";

/* ------------------------------------------------------------------ */
/* Person entity fixes                                                 */
/* ------------------------------------------------------------------ */

/**
 * Fixes for the key-person entity surface. `schemaOutcome` is the M10-produced
 * Person schema (null when no key person / no schema was attempted).
 */
export function personFixes(
  person: PersonEntityAssessment,
  schemaOutcome: EntitySchemaOutcome | null,
): EntityFixDraft[] {
  if (person.status !== "assessed") return []; // not assessable / no key person — no honest on-site fix
  const fixes: EntityFixDraft[] = [];
  const name = person.keyPersonName ?? "the key person";

  // Person name absent from the page — the visible-text gate blocks any Person
  // schema asserting it. The honest ask is to surface the person on-page first.
  if (!person.namePresentOnPage) {
    fixes.push({
      id: "pr/person-onpage-name",
      checkId: "entity_consistency",
      title: `Surface ${name} on the site as a named entity`,
      detail:
        `"${name}" does not appear in the site's visible text, so Person schema asserting this name is rejected by the ` +
        "visible-text gate. Add an author/about/bio surface naming the person before the entity schema can publish. We draft it for your approval.",
      targetUrls: [],
      impact: "high",
      impactEstimate: "AI engines cannot resolve a key-person entity that never appears on the page — this blocks every downstream entity signal.",
      module: M12_MODULE,
      automationLevel: "ai_draft_human_approve",
    });
    return fixes; // the schema fixes below depend on the name being present first
  }

  if (schemaOutcome !== null) {
    if (schemaOutcome.result.status === "rejected") {
      fixes.push({
        id: "pr/person-schema-blocked",
        checkId: "schema_presence_validity",
        title: `Add on-page facts so ${name}'s Person schema can publish`,
        detail:
          "The proposed Person schema was rejected by the visible-text gate — it would assert facts the page does not show. " +
          "Add the missing details to the page's visible text, then the Person entity schema can ship safely.",
        targetUrls: [],
        impact: "high",
        impactEstimate: "Person schema that doesn't match visible text is a manual-action risk — the gate blocks it until the page shows the facts.",
        module: M12_MODULE,
        automationLevel: "ai_draft_human_approve",
      });
    } else if (!person.personSchemaPresent) {
      const sameAsNote =
        schemaOutcome.sameAs.length > 0
          ? ` It aggregates ${schemaOutcome.sameAs.length} sameAs entity signal(s) — each requires human confirmation of genuineness before publish (${schemaOutcome.uncorroboratedSameAs.length} not yet corroborated on-page).`
          : " No sameAs signals were supplied — add the client's known press/profile URLs to strengthen entity resolution.";
      fixes.push({
        id: "pr/person-schema-publish",
        checkId: "schema_presence_validity",
        title: `Publish Person schema for ${name}`,
        detail:
          `A valid Person JSON-LD block matches the page's visible text and is ready for a diff-previewed, human-approved injection.${sameAsNote}`,
        targetUrls: [],
        impact: "high",
        impactEstimate: "Person schema with sameAs is the primary entity-resolution signal — it ties the founder to their press and profiles across AI engines.",
        module: M12_MODULE,
        automationLevel: "ai_draft_human_approve",
      });
    }
  }

  // Person schema exists but carries no sameAs — the highest-value entity signal
  // is missing. Only raised when we have sameAs to add.
  if (
    person.personSchemaPresent &&
    !person.sameAsPresentInSchema &&
    schemaOutcome !== null &&
    schemaOutcome.sameAs.length > 0
  ) {
    fixes.push({
      id: "pr/person-sameas",
      checkId: "entity_consistency",
      title: `Add sameAs press/profile signals to ${name}'s Person schema`,
      detail:
        `The existing Person schema declares no sameAs. Adding the client's ${schemaOutcome.sameAs.length} known press/profile URL(s) ` +
        "aggregates their authority into one entity signal. Each sameAs requires human confirmation of genuineness before publish.",
      targetUrls: [],
      impact: "medium",
      impactEstimate: "sameAs is the strongest signal linking a person to their off-site authority (press, profiles, credential registries).",
      module: M12_MODULE,
      automationLevel: "ai_draft_human_approve",
    });
  }

  return fixes;
}

/* ------------------------------------------------------------------ */
/* Press surface fixes                                                 */
/* ------------------------------------------------------------------ */

/** Fixes for the press surface + uncorroborated press claims. */
export function pressFixes(press: PressSurfaceAssessment): EntityFixDraft[] {
  if (press.status !== "assessed") return []; // uncrawlable — no honest on-site fix to raise
  const fixes: EntityFixDraft[] = [];

  // Corroborated press exists but there is no surface presenting it.
  if (!press.pressSectionPresent && press.corroboratedCount > 0) {
    fixes.push({
      id: "pr/press-section",
      checkId: "entity_consistency",
      title: 'Build an "As Featured In" press surface',
      detail:
        `${press.corroboratedCount} of ${press.claimedCount} supplied press item(s) are corroborated on-page but there is no press ` +
        'surface presenting them. Build an "As Featured In" section from the corroborated mentions (with the publication links). We draft it for your approval.',
      targetUrls: [],
      impact: "medium",
      impactEstimate: "A press surface concentrates existing third-party authority signals AI engines weigh for entity trust.",
      module: M12_MODULE,
      automationLevel: "ai_draft_human_approve",
    });
  }

  // Supplied press that the page does NOT reference — surface the real mention
  // on-page (never fabricate it).
  const uncorroborated = press.claimedPress.filter((p) => !p.mentionedOnPage);
  if (uncorroborated.length > 0) {
    fixes.push({
      id: "pr/press-corroborate",
      checkId: "entity_consistency",
      title: `Reference ${uncorroborated.length} supplied publication(s) on the site`,
      detail:
        `These supplied press items are not mentioned anywhere in the site's visible text: ${uncorroborated
          .map((p) => p.publication)
          .join(", ")}. ` +
        "Add an honest on-page mention (\"As featured in [Publication]…\") for the genuine ones so the authority becomes an on-page signal and can feed the entity sameAs. We never assert a mention the page cannot support.",
      targetUrls: [],
      impact: "medium",
      impactEstimate: "Off-page press only becomes a strong entity signal once the client's own page references it — an on-page anchor engines can read.",
      module: M12_MODULE,
      automationLevel: "ai_draft_human_approve",
    });
  }

  return fixes;
}
