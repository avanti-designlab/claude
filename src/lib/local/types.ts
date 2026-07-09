/**
 * M14 Local SEO — the per-location assessment contract (doc 05 M14, doc 07 §1.6).
 *
 * A client with N locations (`clients.locations`) gets N per-location
 * assessments. Every field is honesty-first: a signal that could NOT be
 * measured (site uncrawlable, GBP not connected, no canonical value on record,
 * no discoverable ZIP) is stated as such — NEVER a fabricated score. That is
 * the whole point of the multi-location honesty rule.
 */

import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import type { FixDraft } from "@/lib/skills/aeo-audit";
import type { LocalIntensityLevel } from "./intensity";

/* ------------------------------------------------------------------ */
/* NAP (name / address / phone) consistency — client's OWN site        */
/* ------------------------------------------------------------------ */

/** Per-field NAP verdict against the client's own site (the crawl layer). */
export type NapFieldStatus =
  /** Canonical value found on the site, consistent (schema and/or visible text). */
  | "match"
  /** The site's local schema asserts a DIFFERENT value than the canonical record. */
  | "mismatch"
  /** Canonical value exists but appears nowhere on the crawled site. */
  | "absent"
  /** Nothing canonical to check (e.g. no phone on the location record). */
  | "no_canonical"
  /** Site had no crawlable pages — the verdict is withheld, never fabricated. */
  | "not_assessable";

export interface NapFieldAssessment {
  field: "name" | "address" | "phone";
  status: NapFieldStatus;
  /** The canonical value checked for (operator-entered — not a secret). */
  canonical: string | null;
  /** The conflicting on-site value, present only when status === "mismatch". */
  foundOnSite: string | null;
  message: string;
}

export interface NapAssessment {
  fields: NapFieldAssessment[];
  /** True only when every checkable field matched. Never true when unassessable. */
  consistent: boolean;
  /** False when the site had no crawlable pages (the on-site half is withheld). */
  assessable: boolean;
}

/* ------------------------------------------------------------------ */
/* GBP (Google Business Profile) — via the deferred GBP data provider  */
/* ------------------------------------------------------------------ */

export type GbpConnectionStatus = "connected" | "not_connected";

export interface GbpAssessment {
  status: GbpConnectionStatus;
  /** 0–100 completeness (the aeo-audit skill's GBP check) — null when not connected. */
  completenessScore: number | null;
  /** Field gaps from the skill — [] when not connected (unknown, NOT zero). */
  gaps: string[];
}

/* ------------------------------------------------------------------ */
/* Local-pack readiness by ZIP                                         */
/* ------------------------------------------------------------------ */

/**
 * Local-pack READINESS (the on-page + GBP preconditions for local-pack
 * presence in a ZIP) — NOT a live rank. Rank tracking needs a deferred vendor
 * connector (like GBP); until it lands, absence is stated honestly, never a
 * fabricated position.
 */
export type LocalPackReadiness = "ready" | "partial" | "not_ready" | "not_assessable";

export interface LocalPackAssessment {
  readiness: LocalPackReadiness;
  /** ZIP the readiness is scoped to; null when none is discoverable → not_assessable. */
  zip: string | null;
  /** Readiness inputs (nap consistent, local schema present, gbp connected/complete). */
  signals: string[];
}

/* ------------------------------------------------------------------ */
/* Per-location + whole-client report                                  */
/* ------------------------------------------------------------------ */

export type LocationAssessmentStatus =
  /** At least one signal (site or GBP) was measurable. */
  | "assessed"
  /** The location record has no usable name or address — nothing to assess. */
  | "insufficient_canonical"
  /** Neither site nor GBP produced any signal — never scored. */
  | "no_data";

export interface LocationAssessment {
  /** Index into `clients.locations` — stable identity across a multi-location client. */
  locationIndex: number;
  locationName: string | null;
  status: LocationAssessmentStatus;
  nap: NapAssessment;
  gbp: GbpAssessment;
  localPack: LocalPackAssessment;
  /** True when the site shows enough to inject a valid LocalBusiness-class schema block. */
  schemaReady: boolean;
  /** Honest per-location notes — what was, and was not, measurable. */
  notes: string[];
}

export interface LocalReport {
  vertical: string;
  intensity: LocalIntensityLevel;
  /** False for OFF playbooks — an explicit empty report, never a fabricated score. */
  active: boolean;
  crawledAt: string;
  /** One entry per `clients.locations` row (multi-location honesty). */
  locations: LocationAssessment[];
  /** Whole-site crawl honesty (from crawlSite) — what the on-site half is based on. Null when OFF. */
  coverage: CrawlCoverage | null;
  /**
   * Prioritized-later local fixes. FixDraft (no priorityScore): priority is
   * assigned by the playbook-aware generator at the plan-merge seam
   * (`localPlanInput` → generatePlan), exactly like M6/M4's projections.
   */
  fixes: FixDraft[];
}
