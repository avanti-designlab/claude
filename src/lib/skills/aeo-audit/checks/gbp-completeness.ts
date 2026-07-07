/**
 * Check 8 — GBP completeness, per the playbook's local intensity (SKILL.md).
 * Field-weighted completeness per location profile, averaged across locations.
 * Gating (national → OFF, gbp_priority "off" → OFF) happens in audit.ts —
 * this check only runs when GBP is in scope.
 */

import type { CheckContext, CheckOutcome, EvidenceItem, FixDraft, GbpProfileInput, ImpactLevel } from "../types";
import { round1 } from "../util";

const MIN_PHOTOS = 5;

interface FieldScore {
  field: string;
  points: number;
  earned: number;
  finding?: string;
}

function scoreProfile(profile: GbpProfileInput): { score: number; findings: FieldScore[] } {
  const findings: FieldScore[] = [
    {
      field: "primaryCategory",
      points: 15,
      earned: profile.primaryCategory !== null && profile.primaryCategory.trim() !== "" ? 15 : 0,
      finding: "Primary category is not set.",
    },
    {
      field: "hours",
      points: 15,
      earned: profile.hoursComplete ? 15 : 0,
      finding: "Business hours are incomplete.",
    },
    {
      field: "description",
      points: 10,
      earned: profile.description !== null && profile.description.trim() !== "" ? 10 : 0,
      finding: "Business description is missing.",
    },
    {
      field: "phone",
      points: 10,
      earned: profile.phone !== null && profile.phone.trim() !== "" ? 10 : 0,
      finding: "Phone number is missing.",
    },
    {
      field: "address",
      points: 10,
      earned: profile.address !== null && profile.address.trim() !== "" ? 10 : 0,
      finding: "Address is missing.",
    },
    {
      field: "websiteUrl",
      points: 10,
      earned: profile.websiteUrl !== null && profile.websiteUrl.trim() !== "" ? 10 : 0,
      finding: "Website link is missing.",
    },
    {
      field: "photos",
      points: 10,
      earned: round1(Math.min(profile.photoCount, MIN_PHOTOS) / MIN_PHOTOS * 10),
      finding: `Fewer than ${MIN_PHOTOS} photos (found ${profile.photoCount}).`,
    },
    {
      field: "attributes",
      points: 10,
      earned: profile.attributesComplete ? 10 : 0,
      finding: "Attributes are incomplete.",
    },
    {
      field: "posts",
      points: 10,
      earned: profile.postsLast30Days >= 1 ? 10 : 0,
      finding: "No GBP posts in the last 30 days.",
    },
  ];
  const score = findings.reduce((sum, f) => sum + f.earned, 0);
  return { score, findings };
}

export function checkGbpCompleteness(ctx: CheckContext): CheckOutcome {
  const { site, playbook } = ctx;
  const profiles = site.gbpProfiles;

  if (profiles === undefined || profiles.length === 0) {
    return {
      status: "skipped",
      skipReason: "no_data",
      score: null,
      evidence: [{ message: "No GBP profile data supplied — connect the GBP connector (M14) to score completeness." }],
      fixes: [],
    };
  }

  const evidence: EvidenceItem[] = [];
  const fixes: FixDraft[] = [];
  let scoreSum = 0;

  for (const profile of profiles) {
    const { score, findings } = scoreProfile(profile);
    scoreSum += score;
    const gaps = findings.filter((f) => f.earned < f.points);
    for (const gap of gaps) {
      evidence.push({
        url: `gbp:${profile.locationName}`,
        field: gap.field,
        message: gap.finding ?? `${gap.field} incomplete.`,
      });
    }
    if (gaps.length > 0) {
      const priority = playbook.local_module_config.gbp_priority;
      const impact: ImpactLevel =
        priority === "critical" ? (score < 60 ? "critical" : "high") : priority === "high" ? "high" : "medium";
      fixes.push({
        id: `gbp_completeness/complete-${profile.locationName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
        checkId: "gbp_completeness",
        title: `Complete the GBP profile for "${profile.locationName}" (${gaps.length} gap(s))`,
        detail: `Missing/weak fields: ${gaps.map((g) => g.field).join(", ")}. GBP priority for this vertical: ${priority}.`,
        targetUrls: [`gbp:${profile.locationName}`],
        impact,
        impactEstimate:
          impact === "critical" || impact === "high"
            ? "High — GBP completeness directly drives local-pack ranking and 'near me' AI answers in this vertical."
            : "Medium — GBP completeness supports semi-local visibility for this vertical.",
        module: "M14",
        automationLevel: "ai_draft_human_approve",
      });
    }
  }

  return { status: "scored", score: round1(scoreSum / profiles.length), evidence, fixes };
}
