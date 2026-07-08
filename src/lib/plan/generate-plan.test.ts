/**
 * `generatePlan` contract tests (M1 · doc 07 §1.1: "Plan generator: playbook +
 * audit → prioritized, channel-weighted task roadmap").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RED SUITE — KNOWN SOURCE GAP (reported, do not "fix" these tests):
 * src/lib/plan/index.ts still contains the Phase-1.1 seam STUB. The first-slice
 * commit (1b29504) built the generator's internals (archetypes / scoring /
 * audit-merge) but never wired them into `generatePlan`, which returns an
 * empty roadmap ({} allocation, [] tasks, "" summary). The onboarding flow
 * (src/components/onboarding/onboarding-flow.tsx) calls this function, so the
 * live flow currently renders the empty-plan state for every vertical.
 *
 * Every test in the "contract (RED …)" block below encodes required doc 02 /
 * doc 07 §1.1 behavior and stays red until the real generator lands.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { describe, expect, it } from "vitest";
import { generatePlan } from "./index";
import { sortTasks } from "./scoring";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";
import type { AuditFix, AuditResult } from "@/lib/skills/aeo-audit";

const NOW = "2026-07-08T00:00:00.000Z";

function gbpFix(): AuditFix {
  return {
    id: "gbp_completeness/complete-profile",
    checkId: "gbp_completeness",
    title: "Complete the Google Business Profile",
    detail: "Hours, categories, and photos are missing.",
    targetUrls: [],
    impact: "critical",
    impactEstimate: "Critical — GBP drives 'near me' answers",
    module: "M14",
    automationLevel: "ai_draft_human_approve",
    priorityScore: 200,
  };
}

function smallAudit(): AuditResult {
  return {
    overallScore: 48,
    checks: [],
    fixes: [gbpFix()],
    dataGaps: [],
    playbookVertical: "restaurants",
    localChecksApplied: true,
    crawledAt: "2026-07-01T00:00:00.000Z",
  };
}

describe("generatePlan — metadata + purity (passes even against the stub)", () => {
  it("carries the playbook's vertical and version and the caller-supplied timestamp", () => {
    const roadmap = generatePlan({ playbook: SEED_PLAYBOOKS.restaurants, now: NOW });
    expect(roadmap.vertical).toBe("restaurants");
    expect(roadmap.playbookVersion).toBe("1.0.0");
    expect(roadmap.generatedAt).toBe(NOW);
  });

  it("is deterministic: identical inputs produce an identical roadmap", () => {
    const a = generatePlan({ playbook: SEED_PLAYBOOKS.restaurants, now: NOW, audit: smallAudit() });
    const b = generatePlan({ playbook: SEED_PLAYBOOKS.restaurants, now: NOW, audit: smallAudit() });
    expect(b).toEqual(a);
  });
});

describe("generatePlan — contract (RED: generatePlan is still the 1.1 seam stub)", () => {
  // RED: the stub returns tasks: [] — a playbook-only plan must still produce
  // channel tasks (doc 02: the playbook alone drives the roadmap; the audit
  // only adds gap-closing tasks on top).
  it("generates channel tasks from the playbook alone (empty audit)", () => {
    const roadmap = generatePlan({ playbook: SEED_PLAYBOOKS.restaurants, now: NOW });
    expect(roadmap.tasks.length).toBeGreaterThan(0);

    const weightedKeys = Object.entries(SEED_PLAYBOOKS.restaurants.channel_weighting)
      .filter(([, w]) => w > 0)
      .map(([channel]) => channel);
    for (const task of roadmap.tasks) {
      expect(weightedKeys).toContain(task.channel);
    }
  });

  // RED: zero-weight channels must anchor nothing (ecommerce "Local" is 0).
  it("anchors no tasks on zero-weight channels", () => {
    const roadmap = generatePlan({ playbook: SEED_PLAYBOOKS.ecommerce, now: NOW });
    expect(roadmap.tasks.length).toBeGreaterThan(0);
    expect(roadmap.tasks.map((t) => t.channel)).not.toContain("Local");
  });

  // RED: the stub returns channelAllocation: {} — allocation must follow
  // channel_weighting proportionally, never an even split (doc 02 rule).
  it("allocates effort proportionally to channel_weighting, summing to 1", () => {
    const roadmap = generatePlan({ playbook: SEED_PLAYBOOKS.restaurants, now: NOW });
    const allocation = roadmap.channelAllocation;
    expect(Object.keys(allocation).length).toBeGreaterThan(0);

    const total = Object.values(allocation).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);

    const gbpShare = allocation["Google Business Profile + local"] ?? 0;
    const reservationShare = allocation["Reservation-platform presence"] ?? 0;
    expect(gbpShare).toBeGreaterThan(reservationShare); // 35-weight ≫ 5-weight
  });

  // RED: audit fixes must merge into the roadmap as gap-closing tasks with
  // their module + automation level intact.
  it("merges audit fixes into the roadmap (module + automationLevel passthrough)", () => {
    const roadmap = generatePlan({
      playbook: SEED_PLAYBOOKS.restaurants,
      now: NOW,
      audit: smallAudit(),
    });
    const auditTask = roadmap.tasks.find((t) => t.id === "audit/gbp_completeness/complete-profile");
    expect(auditTask).toBeDefined();
    expect(auditTask?.source).toBe("audit");
    expect(auditTask?.module).toBe("M14");
    expect(auditTask?.automationLevel).toBe("ai_draft_human_approve");
  });

  // RED: roadmap structure — unique ids, sorted deterministically, non-empty
  // Content-Quality-gated summary.
  it("emits a structurally sound roadmap: unique ids, priorityScore-desc order, summary", () => {
    const roadmap = generatePlan({
      playbook: SEED_PLAYBOOKS.restaurants,
      now: NOW,
      audit: smallAudit(),
    });
    expect(roadmap.tasks.length).toBeGreaterThan(0);
    expect(new Set(roadmap.tasks.map((t) => t.id)).size).toBe(roadmap.tasks.length);
    expect(roadmap.tasks.map((t) => t.id)).toEqual(sortTasks(roadmap.tasks).map((t) => t.id));
    expect(roadmap.summary.trim().length).toBeGreaterThan(0);
  });
});
