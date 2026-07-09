/**
 * M14 Local SEO — local completeness (doc 05 M14; task deliverable 1).
 *
 * Two completeness signals per location:
 *   - GBP completeness: scored by REUSING the aeo-audit skill's
 *     `checkGbpCompleteness` on the single location's profile — the field
 *     weights + priority-graded impact are the skill's, never re-derived here.
 *     A location with no GBP connection is honestly `not_connected` (unknown),
 *     never scored 0.
 *   - Local-pack READINESS by ZIP: the on-page + GBP preconditions for
 *     local-pack presence in a ZIP. NOT a live rank (rank tracking is a
 *     deferred vendor connector) — absence is stated, never a fabricated
 *     position.
 *
 * Pure: no network, no clock. GBP-side data arrives already fetched (via the
 * GbpDataProvider port) so this file is deterministic and unit-testable.
 */

import { checkGbpCompleteness, type CrawledSite, type FixDraft, type GbpProfileInput } from "@/lib/skills/aeo-audit";
import { DEFAULT_REFRESH_WINDOW_DAYS } from "@/lib/skills/aeo-audit";
import type { Playbook } from "@/lib/types/playbook";
import type { CanonicalLocation } from "./locations";
import type { GbpLocationResult } from "./gbp-provider";
import { impactForIntensity, localIntensity } from "./intensity";
import type { GbpAssessment, LocalPackAssessment, LocalPackReadiness, NapAssessment } from "./types";

/**
 * Minimal `CrawledSite` carrying ONLY the single GBP profile, so the skill's
 * `checkGbpCompleteness` scores exactly this location. The GBP check reads only
 * `site.gbpProfiles` + `playbook` — every other field is an unused stub.
 */
function singleProfileSite(profile: GbpProfileInput): CrawledSite {
  return {
    baseUrl: "",
    crawledAt: "",
    pages: [],
    robotsTxt: null,
    llmsTxt: null,
    gbpProfiles: [profile],
  };
}

/** GBP completeness for one location + the skill's own gap fixes (module M14). */
export function assessGbp(
  gbp: GbpLocationResult,
  playbook: Playbook,
): { assessment: GbpAssessment; fixes: FixDraft[] } {
  if (!gbp.connected) {
    return {
      assessment: { status: "not_connected", completenessScore: null, gaps: [] },
      fixes: [
        {
          id: "local/connect-gbp",
          checkId: "gbp_completeness",
          title: "Connect the Google Business Profile for this location",
          detail:
            "No Google Business Profile data is connected for this location, so GBP completeness is UNKNOWN (not zero). " +
            "Connecting the profile is an account-verification step done by a human.",
          targetUrls: [],
          impact: impactForIntensity(localIntensity(playbook)),
          impactEstimate:
            "GBP is a primary local-pack and 'near me' AI-answer signal in this vertical — until it's connected we can't measure or improve it.",
          module: "M14",
          automationLevel: "human_only",
        },
      ],
    };
  }

  const outcome = checkGbpCompleteness({
    site: singleProfileSite(gbp.profile),
    playbook,
    options: { refreshWindowDays: DEFAULT_REFRESH_WINDOW_DAYS },
  });
  const gaps = outcome.evidence
    .map((e) => e.field ?? e.message)
    .filter((v): v is string => v !== undefined);
  return {
    assessment: { status: "connected", completenessScore: outcome.score, gaps },
    // The skill's fixes are already module M14 + priority-graded by gbp_priority.
    fixes: outcome.fixes,
  };
}

/**
 * Doc-silent readiness threshold — how complete a connected GBP must be to count
 * as a positive local-pack signal. Flagged for ratification alongside the other
 * local launch thresholds (BUILD-STATE ⚑ list).
 */
export const GBP_READY_MIN_SCORE = 70;

/**
 * Local-pack readiness by ZIP. Readiness is the SHARE of positive preconditions
 * met — NAP consistent on-site, local schema present, GBP connected & complete.
 * When no ZIP is discoverable the readiness is `not_assessable` (we won't claim
 * a ZIP the client never gave us).
 */
export function assessLocalPack(
  location: CanonicalLocation,
  nap: NapAssessment,
  gbp: GbpAssessment,
  schemaReady: boolean,
): LocalPackAssessment {
  if (location.zip === null) {
    return {
      readiness: "not_assessable",
      zip: null,
      signals: ["No ZIP is discoverable for this location — local-pack readiness can't be scoped by ZIP."],
    };
  }

  const gbpReady =
    gbp.status === "connected" && gbp.completenessScore !== null && gbp.completenessScore >= GBP_READY_MIN_SCORE;
  const napReady = nap.assessable && nap.consistent;

  const signals = [
    `NAP consistency on-site: ${nap.assessable ? (nap.consistent ? "consistent" : "inconsistent") : "not assessable"}`,
    `Local schema present + valid: ${schemaReady ? "yes" : "no"}`,
    `GBP connected & complete (≥${GBP_READY_MIN_SCORE}): ${gbp.status === "not_connected" ? "not connected" : gbpReady ? "yes" : "incomplete"}`,
  ];

  const positives = [napReady, schemaReady, gbpReady].filter(Boolean).length;
  let readiness: LocalPackReadiness;
  if (positives === 3) readiness = "ready";
  else if (positives === 0) readiness = "not_ready";
  else readiness = "partial";

  return { readiness, zip: location.zip, signals };
}
