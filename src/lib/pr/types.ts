/**
 * M12 PR entity-leverage — the entity-authority assessment contract
 * (doc 05 M12, doc 07 §1.7).
 *
 * M12 automates the LEVERAGE-WHAT-EXISTS half of PR: turn a client's existing
 * press into entity signals (Person `sameAs`, an "As Featured In" surface,
 * on-page publication mentions). Every field is HONESTY-FIRST, exactly like
 * M14's local report: a signal that could not be measured (site uncrawlable) is
 * SAID SO, never a fabricated score; a press claim not corroborated on the
 * client's own page is FLAGGED, never silently asserted as authority.
 *
 * NO FABRICATED CREDENTIALS/ENTITIES/PRESS (task point 4): M12 never invents a
 * publication, a byline, an award, or a profile. The entity SCHEMA is produced
 * through M10's visible-text gate (entity-schema.ts), so a Person NAME the page
 * does not show REJECTS; and a `sameAs`/press item that is not corroborated in
 * the page's own visible text is surfaced as an honest gap, never asserted.
 */

import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import type { AutomationLevel, CheckId, ImpactLevel } from "@/lib/skills/aeo-audit";

/**
 * The owning-module code for M12 fixes. NOTE: the aeo-audit skill's
 * `OwningModule` enum predates M12 and does NOT include it (the skill is frozen
 * and out of bounds to change). "M12" IS a valid roadmap `ModuleRef`, and the
 * plan-merge seam already models it (`MODULE_CHANNEL_ARCHETYPES.M12 =
 * ["entity","offsite","podcast"]`, src/lib/plan/audit-merge.ts) — so an M12 fix
 * homes to the playbook's entity channel. See plan-input.ts for how this rides
 * through the `audit`-shaped seam that reads only `.fixes` at runtime.
 */
export const M12_MODULE = "M12" as const;

/**
 * An M12 fix — the aeo-audit `FixDraft` SHAPE, with `module` pinned to "M12".
 * It is structurally what `auditTasks` reads (id/checkId/title/detail/impact/
 * impactEstimate/module/automationLevel), so it flows through the SAME plan
 * merge M2/M14 use, with no parallel plan logic. `checkId` is a real rubric
 * check id (`entity_consistency` for entity/press surface work,
 * `schema_presence_validity` for the schema-publish/blocked fixes) so the fix
 * stays legible to the rubric even though M12 owns it.
 */
export interface EntityFixDraft {
  /** Stable, deterministic id — "pr/<slug>". */
  id: string;
  checkId: CheckId;
  title: string;
  detail: string;
  targetUrls: string[];
  impact: ImpactLevel;
  impactEstimate: string;
  module: typeof M12_MODULE;
  automationLevel: AutomationLevel;
}

/* ------------------------------------------------------------------ */
/* Key-person (founder / principal) entity authority — the client's OWN site */
/* ------------------------------------------------------------------ */

export type PersonAssessmentStatus =
  /** The site had at least one crawlable page AND a key person was named to check. */
  | "assessed"
  /** No key person (founder/principal) was supplied — nothing to assess. */
  | "no_key_person"
  /** The site had no crawlable pages — the on-site verdict is withheld, never fabricated. */
  | "not_assessable";

export interface PersonEntityAssessment {
  status: PersonAssessmentStatus;
  /** The claimed key-person name (operator-entered — not a secret), or null. */
  keyPersonName: string | null;
  /** True only when the key-person name appears in the crawled visible text. */
  namePresentOnPage: boolean;
  /** True when an existing `@type:"Person"` JSON-LD block was found on the site. */
  personSchemaPresent: boolean;
  /** True when an existing Person block already carries a non-empty `sameAs`. */
  sameAsPresentInSchema: boolean;
  /** Honest notes — what was, and was not, measurable. */
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Press surface ("As Featured In") + on-page publication mentions     */
/* ------------------------------------------------------------------ */

/** One claimed press item, assessed against the client's OWN page (corroboration). */
export interface PressItemAssessment {
  /** Publication label (operator-entered or derived from the article URL host). */
  publication: string;
  /** The press article URL, when provided. */
  url: string | null;
  /**
   * True when the publication label (or the article URL's registrable domain
   * label) appears in the crawled visible text — the page itself corroborates
   * the press mention. False = the claim is NOT supported on the client's page,
   * so it is FLAGGED, never asserted as on-page authority.
   */
  mentionedOnPage: boolean;
  note: string;
}

export type PressAssessmentStatus = "assessed" | "not_assessable";

export interface PressSurfaceAssessment {
  status: PressAssessmentStatus;
  /**
   * True when a Press / "As Featured In" / media surface marker was found in the
   * crawled visible text or a heading. Deliberately conservative (curated
   * multi-word markers + exact short-heading matches) — a false positive would
   * hand out unearned authority credit.
   */
  pressSectionPresent: boolean;
  /** Per-claimed-press corroboration against the client's own page. */
  claimedPress: PressItemAssessment[];
  /** Count of claimed press items corroborated on-page (never > claimedCount). */
  corroboratedCount: number;
  claimedCount: number;
  notes: string[];
}

/* ------------------------------------------------------------------ */
/* Whole-client entity-authority report                                */
/* ------------------------------------------------------------------ */

export interface EntityAuthorityReport {
  vertical: string;
  crawledAt: string;
  /** False when the site had no crawlable pages — every on-site verdict withheld. */
  assessable: boolean;
  person: PersonEntityAssessment;
  press: PressSurfaceAssessment;
  /** Whole-site crawl honesty (from crawlSite) — what the on-site half is based on. */
  coverage: CrawlCoverage | null;
  /**
   * Prioritized-later entity-authority fixes. Priority is assigned by the
   * playbook-aware generator at the plan-merge seam (`entityPlanInput` →
   * generatePlan), exactly like M6/M4/M14's projections — never here.
   */
  fixes: EntityFixDraft[];
}
