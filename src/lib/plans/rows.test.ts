/**
 * Roadmap → insert-row mapping suite (plan persistence, migration 0004).
 *
 * Pins the frozen-schema mapping (doc 03 §3) and the automation_level rules
 * (doc 03 §6 / CLAUDE.md rule 5) at the persistence seam:
 *  - one `tasks` row per roadmap item, scoping ids pinned on EVERY row
 *  - payload carries the item's details; promoted columns are not duplicated
 *  - automation_level never leaves the frozen CHECK set
 *    ('auto' | 'ai_draft_human_approve' | 'human_only')
 *  - a corrupted level falls to 'ai_draft_human_approve' — NEVER 'auto';
 *    'auto' survives only when the generator itself emitted exactly 'auto'
 */

import { describe, expect, it } from "vitest";
import { generatePlan } from "@/lib/plan";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";
import { AUTOMATION_LEVELS, type AutomationLevel } from "@/lib/types/db";
import type { GeneratedRoadmap, RoadmapTask } from "@/lib/types/roadmap";
import { clampAutomationLevel, planInsertRow, taskInsertRows } from "./rows";

const NOW = "2026-07-09T00:00:00.000Z";
const SCOPE = { tenantId: "tenant-1", clientId: "client-1", planId: "plan-1" };

function roadmapTask(overrides: Partial<RoadmapTask> = {}): RoadmapTask {
  return {
    id: "channel/gbp/complete-profile",
    title: "Complete the Google Business Profile",
    description: "Hours, categories, and photos are missing.",
    module: "M14",
    channel: "Google Business Profile + local",
    source: "playbook",
    impact: "critical",
    priorityScore: 180,
    effortWeight: 2,
    automationLevel: "ai_draft_human_approve",
    ...overrides,
  };
}

function roadmap(tasks: RoadmapTask[]): GeneratedRoadmap {
  return {
    vertical: "real-estate",
    playbookVersion: "1.0.0",
    generatedAt: NOW,
    channelAllocation: { "Google Business Profile + local": 1 },
    tasks,
    summary: "A one-channel plan for the mapping tests.",
  };
}

describe("planInsertRow", () => {
  it("pins tenant/client scope and carries the version + full roadmap", () => {
    const generated = roadmap([roadmapTask()]);
    const row = planInsertRow({
      tenantId: SCOPE.tenantId,
      clientId: SCOPE.clientId,
      roadmap: generated,
    });
    expect(row).toEqual({
      tenant_id: "tenant-1",
      client_id: "client-1",
      playbook_version: "1.0.0",
      generated_roadmap: generated,
    });
  });
});

describe("taskInsertRows — mapping (doc 03 §3)", () => {
  it("emits one row per roadmap item, in roadmap order, with scoping ids and status 'todo' on every row", () => {
    const tasks = [
      roadmapTask(),
      roadmapTask({ id: "audit/schema/faq", module: "M10", channel: "FAQ" }),
    ];
    const rows = taskInsertRows({ ...SCOPE, roadmap: roadmap(tasks) });

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.payload.id)).toEqual(tasks.map((t) => t.id));
    for (const row of rows) {
      expect(row.tenant_id).toBe("tenant-1");
      expect(row.client_id).toBe("client-1");
      expect(row.plan_id).toBe("plan-1");
      expect(row.status).toBe("todo");
    }
    expect(rows.map((r) => r.module)).toEqual(["M14", "M10"]);
  });

  it("carries the item's details in payload without duplicating promoted columns", () => {
    const task = roadmapTask({ source: "audit", impact: "high" });
    const [row] = taskInsertRows({ ...SCOPE, roadmap: roadmap([task]) });

    expect(row.payload).toEqual({
      id: task.id,
      title: task.title,
      description: task.description,
      channel: task.channel,
      source: "audit",
      impact: "high",
      priorityScore: task.priorityScore,
      effortWeight: task.effortWeight,
    });
    // module / automation_level / status live in their columns ONLY — a stale
    // jsonb copy of an automation level is the drift rule 5 exists to prevent.
    expect(row.payload).not.toHaveProperty("module");
    expect(row.payload).not.toHaveProperty("automationLevel");
    expect(row.payload).not.toHaveProperty("status");
  });

  it("maps an empty roadmap to zero rows", () => {
    expect(taskInsertRows({ ...SCOPE, roadmap: roadmap([]) })).toEqual([]);
  });
});

describe("automation_level — frozen CHECK set (doc 03 §6, CLAUDE.md rule 5)", () => {
  it("passes each of the three allowed values through unchanged", () => {
    for (const level of AUTOMATION_LEVELS) {
      expect(clampAutomationLevel(level)).toBe(level);
    }
  });

  it("clamps anything outside the set to 'ai_draft_human_approve' — never 'auto'", () => {
    const junk: unknown[] = [
      "AUTO",
      "publish",
      "ai-draft-human-approve",
      "",
      undefined,
      null,
      42,
      { level: "auto" },
    ];
    for (const value of junk) {
      expect(clampAutomationLevel(value)).toBe("ai_draft_human_approve");
    }
  });

  it("a corrupted roadmap item never widens to 'auto' in the emitted row", () => {
    const corrupted = roadmapTask({
      automationLevel: "yolo" as unknown as AutomationLevel,
    });
    const [row] = taskInsertRows({ ...SCOPE, roadmap: roadmap([corrupted]) });
    expect(row.automation_level).toBe("ai_draft_human_approve");
  });

  // Sweep every seed playbook's real generator output through the mapper:
  // every emitted level is in the CHECK set, and 'auto' appears in a row iff
  // the generator emitted exactly 'auto' on that item (pass-through, never
  // invented, never widened).
  for (const [vertical, playbook] of Object.entries(SEED_PLAYBOOKS)) {
    it(`${vertical}: every emitted automation_level is in the CHECK set and mirrors the generator`, () => {
      const generated = generatePlan({ playbook, now: NOW });
      const rows = taskInsertRows({ ...SCOPE, roadmap: generated });
      expect(rows).toHaveLength(generated.tasks.length);
      rows.forEach((row, index) => {
        expect(AUTOMATION_LEVELS).toContain(row.automation_level);
        expect(row.automation_level).toBe(generated.tasks[index].automationLevel);
        if (row.automation_level === "auto") {
          expect(generated.tasks[index].automationLevel).toBe("auto");
        }
      });
    });
  }
});
