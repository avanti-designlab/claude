/**
 * M4 → plan seam, proven through the REAL generatePlan + real audit-merge
 * (nothing mocked). Pins that a competitor-corroborated client fix becomes an
 * audit-sourced roadmap task carrying the skill's impact/automation truth —
 * the SAME path M2's audit fixes take — and that the plan-input dedupes fixes
 * shared across gaps while preserving gap-priority order.
 */

import { describe, expect, it } from "vitest";
import { generatePlan } from "@/lib/plan";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";
import type { AuditFix, CheckId } from "@/lib/skills/aeo-audit";
import { competitorGapPlanInput } from "./plan-input";
import type { CitationGap, CompetitorGapReport } from "./types";

const PLAYBOOK = SEED_PLAYBOOKS["real-estate"];
const NOW = "2026-07-09T00:00:00.000Z";

function fix(id: string, checkId: CheckId, module: AuditFix["module"]): AuditFix {
  return {
    id,
    checkId,
    title: `Add ${checkId}`,
    detail: "Concrete client-side remediation.",
    targetUrls: [],
    impact: "high",
    impactEstimate: "meaningful citation lift",
    module,
    automationLevel: "ai_draft_human_approve",
    priorityScore: 1,
  };
}

function gap(checkId: CheckId, fixes: AuditFix[]): CitationGap {
  return {
    checkId,
    checkName: checkId,
    competitorsLeading: 1,
    competitorsCompared: 1,
    clientScore: 40,
    leaders: [{ name: "Rival", citedUrl: "https://rival.example", score: 90 }],
    compared: [{ name: "Rival", citedUrl: "https://rival.example", score: 90 }],
    fixes,
    summary: "1 of 1 crawlable cited competitor leads you.",
  };
}

function report(gaps: CitationGap[]): CompetitorGapReport {
  return {
    playbookVertical: "real-estate",
    playbookVersion: "1.0.0",
    analyzedAt: NOW,
    competitorsScored: 1,
    excluded: [],
    gaps,
    competitors: [],
    noCrawlableCompetitors: false,
  };
}

describe("competitorGapPlanInput", () => {
  it("collects distinct client fixes across gaps, gap order preserved, deduped by id", () => {
    const shared = fix("schema/x", "schema_presence_validity", "M10");
    const input = competitorGapPlanInput(
      report([
        gap("schema_presence_validity", [shared]),
        gap("faq_direct_answer", [fix("faq/y", "faq_direct_answer", "M8"), shared /* dup id */]),
      ]),
    );
    expect(input.fixes.map((f) => f.id)).toEqual(["schema/x", "faq/y"]);
  });

  it("a gap with no client fix contributes nothing", () => {
    const input = competitorGapPlanInput(report([gap("schema_presence_validity", [])]));
    expect(input.fixes).toEqual([]);
  });
});

describe("competitor gaps → generatePlan (real audit-merge seam)", () => {
  it("each corroborated client fix becomes an audit-sourced task with the skill's impact truth", () => {
    const gapReport = report([
      gap("schema_presence_validity", [fix("schema_presence_validity/add-faqpage", "schema_presence_validity", "M10")]),
      gap("onpage_basics", [fix("onpage_basics/titles", "onpage_basics", "M8")]),
    ]);
    const planInput = competitorGapPlanInput(gapReport);

    const roadmap = generatePlan({ playbook: PLAYBOOK, now: NOW, audit: planInput });
    const auditTasks = roadmap.tasks.filter((t) => t.source === "audit");

    expect(auditTasks.map((t) => t.id).sort()).toEqual(
      ["audit/onpage_basics/titles", "audit/schema_presence_validity/add-faqpage"],
    );
    for (const fixObj of planInput.fixes) {
      const task = auditTasks.find((t) => t.id === `audit/${fixObj.id}`);
      expect(task).toBeDefined();
      expect(task!.title).toBe(fixObj.title);
      expect(task!.impact).toBe(fixObj.impact);
      // Every merged task lands on a REAL playbook channel.
      expect(Object.keys(PLAYBOOK.channel_weighting)).toContain(task!.channel);
    }
  });

  it("an empty gap report leaves a playbook-only plan untouched", () => {
    const planInput = competitorGapPlanInput(report([]));
    const roadmap = generatePlan({ playbook: PLAYBOOK, now: NOW, audit: planInput });
    expect(roadmap.tasks.every((t) => t.source === "playbook")).toBe(true);
  });
});
