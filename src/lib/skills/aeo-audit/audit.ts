/**
 * aeo-audit — the audit runner (M2 Audit Engine core).
 *
 * `runAudit(site, playbook, options?)`:
 *   1. runs all 13 rubric checks (local checks 8–10 gated by the playbook —
 *      national / disabled local module → excluded from the score, NOT failed);
 *   2. rolls scored checks into a weighted overall score;
 *   3. flattens every check's fixes into one deterministically prioritized
 *      fix list, with channel_weighting boosting fixes on channels where the
 *      vertical actually builds authority.
 *
 * Pure function of its inputs — no network, no clock, no storage.
 */

import type { Playbook } from "@/lib/types/playbook";
import type {
  AuditFix,
  AuditOptions,
  AuditResult,
  CheckContext,
  CheckFn,
  CheckId,
  CheckOutcome,
  CheckResult,
  CrawledSite,
  SkipReason,
} from "./types";
import { DEFAULT_REFRESH_WINDOW_DAYS } from "./types";
import {
  CHECK_CANONICAL_ORDER,
  CHECK_NAMES,
  channelBoost,
  effectiveCheckWeight,
  IMPACT_FACTOR,
  IMPACT_RANK,
  isLocalCheck,
  localChecksApplicable,
} from "./weights";
import { round1, round2 } from "./util";
import { checkSchemaPresence } from "./checks/schema-presence";
import { checkFaqDirectAnswer } from "./checks/faq-direct-answer";
import { checkVideoTranscript } from "./checks/video-transcript";
import { checkLlmsTxt } from "./checks/llms-txt";
import { checkAiCrawlerAccess } from "./checks/ai-crawler-access";
import { checkInternalLinking } from "./checks/internal-linking";
import { checkEntityConsistency } from "./checks/entity-consistency";
import { checkGbpCompleteness } from "./checks/gbp-completeness";
import { checkNapConsistency } from "./checks/nap-consistency";
import { checkReviewVelocity } from "./checks/review-velocity";
import { checkCoreWebVitals } from "./checks/core-web-vitals";
import { checkFreshness } from "./checks/freshness";
import { checkOnpageBasics } from "./checks/onpage-basics";

const CHECK_RUNNERS: Record<CheckId, CheckFn> = {
  schema_presence_validity: checkSchemaPresence,
  faq_direct_answer: checkFaqDirectAnswer,
  video_transcript_schema: checkVideoTranscript,
  llms_txt: checkLlmsTxt,
  ai_crawler_access: checkAiCrawlerAccess,
  internal_linking: checkInternalLinking,
  entity_consistency: checkEntityConsistency,
  gbp_completeness: checkGbpCompleteness,
  nap_consistency: checkNapConsistency,
  review_velocity: checkReviewVelocity,
  core_web_vitals: checkCoreWebVitals,
  freshness: checkFreshness,
  onpage_basics: checkOnpageBasics,
};

/** Skip outcome for a check gated off by the playbook (never a failure). */
function gatedOffOutcome(checkId: CheckId, playbook: Playbook): CheckOutcome | null {
  if (!isLocalCheck(checkId)) return null;
  if (!localChecksApplicable(playbook)) {
    return {
      status: "skipped",
      skipReason: "local_module_off" satisfies SkipReason,
      score: null,
      evidence: [
        {
          message: `Local module is off for the ${playbook.vertical} playbook (local_intensity: ${playbook.local_intensity}) — check excluded from the score.`,
        },
      ],
      fixes: [],
    };
  }
  if (checkId === "gbp_completeness" && playbook.local_module_config.gbp_priority === "off") {
    return {
      status: "skipped",
      skipReason: "gbp_priority_off" satisfies SkipReason,
      score: null,
      evidence: [{ message: "gbp_priority is 'off' in local_module_config — GBP check excluded from the score." }],
      fixes: [],
    };
  }
  return null;
}

export function runAudit(site: CrawledSite, playbook: Playbook, options?: AuditOptions): AuditResult {
  const ctx: CheckContext = {
    site,
    playbook,
    options: { refreshWindowDays: options?.refreshWindowDays ?? DEFAULT_REFRESH_WINDOW_DAYS },
  };

  const checks: CheckResult[] = CHECK_CANONICAL_ORDER.map((checkId) => {
    const outcome = gatedOffOutcome(checkId, playbook) ?? CHECK_RUNNERS[checkId](ctx);
    const weight = outcome.status === "scored" ? effectiveCheckWeight(checkId, playbook) : 0;

    // Deterministic fix priority:
    //   effective check weight × impact factor × channel boost × severity.
    const severity = outcome.score === null ? 0 : (100 - outcome.score) / 100;
    const boost = channelBoost(checkId, playbook);
    const fixes: AuditFix[] = outcome.fixes.map((draft) => ({
      ...draft,
      priorityScore: round2(weight * IMPACT_FACTOR[draft.impact] * boost * severity),
    }));

    return {
      checkId,
      name: CHECK_NAMES[checkId],
      status: outcome.status,
      ...(outcome.skipReason !== undefined ? { skipReason: outcome.skipReason } : {}),
      score: outcome.score,
      weight,
      evidence: outcome.evidence,
      fixes,
    };
  });

  // Overall: weighted average over applicable, scored checks only.
  let weightSum = 0;
  let weightedScoreSum = 0;
  for (const check of checks) {
    if (check.status === "scored" && check.score !== null && check.weight > 0) {
      weightSum += check.weight;
      weightedScoreSum += check.weight * check.score;
    }
  }
  const overallScore = weightSum === 0 ? 0 : round1(weightedScoreSum / weightSum);

  // Prioritized fix list — deterministic ordering:
  // priorityScore desc → impact rank → canonical check order → fix id.
  const checkOrderIndex = new Map<CheckId, number>(CHECK_CANONICAL_ORDER.map((id, index) => [id, index]));
  const fixes = checks
    .flatMap((check) => check.fixes)
    .sort(
      (a, b) =>
        b.priorityScore - a.priorityScore ||
        IMPACT_RANK[a.impact] - IMPACT_RANK[b.impact] ||
        (checkOrderIndex.get(a.checkId) ?? 0) - (checkOrderIndex.get(b.checkId) ?? 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const dataGaps = checks
    .filter((check) => check.status === "skipped" && check.skipReason === "no_data")
    .map((check) => `${check.name}: ${check.evidence[0]?.message ?? "missing input data"}`);

  return {
    overallScore,
    checks,
    fixes,
    dataGaps,
    playbookVertical: playbook.vertical,
    localChecksApplied: localChecksApplicable(playbook),
    crawledAt: site.crawledAt,
  };
}
