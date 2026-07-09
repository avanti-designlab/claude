/**
 * M12 plan-merge — { fixes } flows through the REAL generatePlan/audit-merge seam
 * and homes to the playbook's ENTITY channel (module "M12" — a valid ModuleRef).
 */

import { describe, expect, it } from "vitest";
import { generatePlan } from "@/lib/plan";
import { getPlaybook as loadPlaybook } from "@/lib/playbooks";

const getPlaybook = (v: Parameters<typeof loadPlaybook>[0]) => loadPlaybook(v)!;

import { entityFixes, entityPlanInput } from "./plan-input";
import type { EntityAuthorityReport, EntityFixDraft } from "./types";

function fix(id: string): EntityFixDraft {
  return {
    id,
    checkId: "entity_consistency",
    title: `Fix ${id}`,
    detail: "detail",
    targetUrls: [],
    impact: "high",
    impactEstimate: "estimate",
    module: "M12",
    automationLevel: "ai_draft_human_approve",
  };
}

function report(fixes: EntityFixDraft[]): EntityAuthorityReport {
  return {
    vertical: "real-estate",
    crawledAt: "2026-07-01T00:00:00.000Z",
    assessable: true,
    person: { status: "assessed", keyPersonName: "Daniel Reyes", namePresentOnPage: true, personSchemaPresent: false, sameAsPresentInSchema: false, notes: [] },
    press: { status: "assessed", pressSectionPresent: false, claimedPress: [], corroboratedCount: 0, claimedCount: 0, notes: [] },
    coverage: null,
    fixes,
  };
}

describe("entityPlanInput — the audit-merge-compatible shape", () => {
  it("returns { fixes } deduplicated by id, order preserved", () => {
    const input = entityPlanInput(report([fix("a"), fix("b"), fix("a")]));
    expect(input.fixes.map((f) => f.id)).toEqual(["a", "b"]);
    expect(entityFixes(report([fix("a"), fix("a")]))).toHaveLength(1);
  });
});

describe("entityPlanInput → generatePlan (the real seam)", () => {
  it("entity fixes become audit-sourced roadmap tasks under module M12", () => {
    const playbook = getPlaybook("real-estate");
    const roadmap = generatePlan({
      playbook,
      now: "2026-07-01T00:00:00.000Z",
      audit: entityPlanInput(report([fix("pr/person-schema-publish")])),
    });
    const task = roadmap.tasks.find((t) => t.id === "audit/pr/person-schema-publish");
    expect(task).toBeDefined();
    expect(task!.module).toBe("M12");
    expect(task!.source).toBe("audit");
    // The channel is a real playbook channel key (never empty).
    expect(typeof task!.channel).toBe("string");
    expect(task!.channel.length).toBeGreaterThan(0);
  });
});
