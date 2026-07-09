import { describe, expect, it } from "vitest";
import { generatePlan } from "@/lib/plan";
import { getPlaybook as loadPlaybook } from "@/lib/playbooks";

/** Seed playbooks are always present — unwrap getPlaybook's null for tests. */
const getPlaybook = (v: Parameters<typeof loadPlaybook>[0]) => loadPlaybook(v)!;
import type { FixDraft } from "@/lib/skills/aeo-audit";
import { localFixes, localPlanInput } from "./plan-input";
import type { LocalReport } from "./types";

function fix(id: string): FixDraft {
  return {
    id,
    checkId: "nap_consistency",
    title: `Fix ${id}`,
    detail: "detail",
    targetUrls: [],
    impact: "high",
    impactEstimate: "estimate",
    module: "M14",
    automationLevel: "ai_draft_human_approve",
  };
}

function report(fixes: FixDraft[]): LocalReport {
  return {
    vertical: "restaurants",
    intensity: "critical",
    active: true,
    crawledAt: "2026-07-01T00:00:00.000Z",
    locations: [],
    coverage: null,
    fixes,
  };
}

describe("localPlanInput — the audit-merge-compatible shape", () => {
  it("returns { fixes } deduplicated by id, order preserved", () => {
    const input = localPlanInput(report([fix("a"), fix("b"), fix("a")]));
    expect(input.fixes.map((f) => f.id)).toEqual(["a", "b"]);
    expect(localFixes(report([fix("a"), fix("a")]))).toHaveLength(1);
  });
});

describe("localPlanInput → generatePlan (the real audit-merge seam)", () => {
  it("local fixes become channel-anchored, audit-sourced roadmap tasks (module M14, local channel)", () => {
    const playbook = getPlaybook("restaurants"); // local ON (critical)
    const roadmap = generatePlan({
      playbook,
      now: "2026-07-01T00:00:00.000Z",
      audit: localPlanInput(report([fix("local/nap-onsite-mismatch-x")])),
    });
    const task = roadmap.tasks.find((t) => t.id === "audit/local/nap-onsite-mismatch-x");
    expect(task).toBeDefined();
    expect(task!.module).toBe("M14");
    expect(task!.source).toBe("audit");
    // The channel is the playbook's own local-archetype channel (contains "local").
    expect(task!.channel).toContain("local");
  });

  it("the audit-merge seam DROPS local fixes when the local module is OFF (ecommerce)", () => {
    const roadmap = generatePlan({
      playbook: getPlaybook("ecommerce"),
      now: "2026-07-01T00:00:00.000Z",
      audit: localPlanInput(report([fix("local/nap-onsite-mismatch-x")])),
    });
    expect(roadmap.tasks.some((t) => t.id === "audit/local/nap-onsite-mismatch-x")).toBe(false);
  });
});
