/**
 * Audit → roadmap merge tests (M1 + M2 seam · Phase 1.1).
 *
 * Covers: AuditResult narrowing, M13 re-homing (incl. the unmapped-check
 * fallback), channel anchoring per module, the local (M14/M15) gate for
 * local-off playbooks, impact/weight monotonicity through the merge, the
 * ×1.25 audit-source boost, and the doc 03 §6 automation-level invariant.
 */

import { describe, expect, it } from "vitest";
import type { AuditFix, AuditResult } from "@/lib/skills/aeo-audit";
import type { Playbook } from "@/lib/types/playbook";
import type { ImpactLevel, RoadmapTask } from "@/lib/types/roadmap";
import {
  asAuditResult,
  auditTasks,
  resolveChannelForModule,
  roadmapModuleForFix,
} from "./audit-merge";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";

function fix(overrides: Partial<AuditFix> & Pick<AuditFix, "id">): AuditFix {
  return {
    checkId: "schema_presence_validity",
    title: "Add MenuItem schema to menu pages",
    detail: "Menu pages ship no MenuItem JSON-LD.",
    targetUrls: ["https://example.com/menu"],
    impact: "high",
    impactEstimate: "High — unlocks AI menu answers",
    module: "M10",
    automationLevel: "ai_draft_human_approve",
    priorityScore: 120,
    ...overrides,
  };
}

function audit(fixes: AuditFix[], playbookVertical = "restaurants"): AuditResult {
  return {
    overallScore: 55,
    checks: [],
    fixes,
    dataGaps: [],
    playbookVertical,
    localChecksApplied: true,
    crawledAt: "2026-07-01T00:00:00.000Z",
  };
}

/**
 * A realistic restaurant audit: one fix per major module, with impacts and
 * automation levels matching what the aeo-audit checks actually emit.
 */
function restaurantAudit(): AuditResult {
  return audit([
    fix({
      id: "gbp_completeness/complete-profile",
      checkId: "gbp_completeness",
      title: "Complete the Google Business Profile",
      module: "M14",
      impact: "critical",
      automationLevel: "ai_draft_human_approve",
    }),
    fix({
      id: "review_velocity/restart-velocity",
      checkId: "review_velocity",
      title: "Restart review velocity",
      module: "M15",
      impact: "high",
      automationLevel: "human_only", // review generation is human work (per the check)
    }),
    fix({
      id: "schema_presence_validity/menu-schema",
      checkId: "schema_presence_validity",
      title: "Add MenuItem schema to menu pages",
      module: "M10",
      impact: "high",
    }),
    fix({
      id: "freshness/stale-menu-page",
      checkId: "freshness",
      title: "Refresh the stale menu page",
      module: "M13", // on-page auto-fix → re-homed to M6 by check
      impact: "medium",
    }),
    fix({
      id: "ai_crawler_access/unblock-gptbot",
      checkId: "ai_crawler_access",
      title: "Unblock GPTBot in robots.txt",
      module: "M13", // on-page auto-fix → re-homed to M5 by check
      impact: "critical",
    }),
  ]);
}

describe("asAuditResult — narrowing an unknown audit input", () => {
  it("rejects null / undefined / primitives", () => {
    expect(asAuditResult(null)).toBeNull();
    expect(asAuditResult(undefined)).toBeNull();
    expect(asAuditResult("audit")).toBeNull();
  });

  it("rejects objects without a fixes array", () => {
    expect(asAuditResult({})).toBeNull();
    expect(asAuditResult({ fixes: "not-an-array" })).toBeNull();
  });

  it("passes a real AuditResult through by reference", () => {
    const real = restaurantAudit();
    expect(asAuditResult(real)).toBe(real);
  });
});

describe("roadmapModuleForFix — M13 re-homing", () => {
  it("passes non-M13 modules straight through", () => {
    const modules = ["M5", "M6", "M8", "M10", "M14", "M15"] as const;
    for (const owningModule of modules) {
      expect(
        roadmapModuleForFix(fix({ id: `pass/${owningModule}`, module: owningModule })),
      ).toBe(owningModule);
    }
  });

  it("re-homes M13 fixes by the check that raised them", () => {
    const cases = [
      ["ai_crawler_access", "M5"],
      ["llms_txt", "M5"],
      ["core_web_vitals", "M5"],
      ["freshness", "M6"],
      ["internal_linking", "M8"],
      ["onpage_basics", "M8"],
      ["entity_consistency", "M8"],
    ] as const;
    for (const [checkId, expected] of cases) {
      expect(roadmapModuleForFix(fix({ id: `m13/${checkId}`, checkId, module: "M13" }))).toBe(
        expected,
      );
    }
  });

  it("falls back to M5 for an M13 fix from an unmapped check (unknown-module edge)", () => {
    // No real check raises M13 under gbp_completeness — this pins the ?? "M5"
    // fallback so a future check addition degrades deterministically.
    expect(
      roadmapModuleForFix(fix({ id: "m13/unmapped", checkId: "gbp_completeness", module: "M13" })),
    ).toBe("M5");
  });
});

describe("resolveChannelForModule — channel anchoring", () => {
  const restaurants = SEED_PLAYBOOKS.restaurants;

  it("anchors each module to its heaviest matching archetype channel (restaurants)", () => {
    expect(resolveChannelForModule("M14", restaurants)?.channel).toBe(
      "Google Business Profile + local",
    );
    expect(resolveChannelForModule("M15", restaurants)?.channel).toBe(
      "Reviews (Google/Yelp/TripAdvisor)",
    );
    expect(resolveChannelForModule("M10", restaurants)?.channel).toBe(
      "Menu schema + indexable menu pages",
    );
  });

  it("prefers a freshness channel for M6 when the playbook has one (real-estate)", () => {
    expect(resolveChannelForModule("M6", SEED_PLAYBOOKS["real-estate"])?.channel).toBe(
      "Evergreen refresh (60–90 day)",
    );
  });

  it("walks the archetype list: M6 falls to content when no freshness channel exists", () => {
    expect(resolveChannelForModule("M6", restaurants)?.channel).toBe(
      "Menu schema + indexable menu pages",
    );
  });

  it("falls back to the overall top channel when no archetype matches", () => {
    const contentOnly: Playbook = {
      ...restaurants,
      channel_weighting: { "On-site education pillars": 40 },
    };
    expect(resolveChannelForModule("M15", contentOnly)?.channel).toBe("On-site education pillars");
  });

  it("returns null when no channel carries weight at all", () => {
    const zeroWeights: Playbook = { ...restaurants, channel_weighting: { "Meta ads": 0 } };
    expect(resolveChannelForModule("M10", zeroWeights)).toBeNull();
  });
});

describe("auditTasks — audit fixes become gap-closing roadmap tasks", () => {
  const restaurants = SEED_PLAYBOOKS.restaurants;

  it("emits one well-formed task per fix, with unique audit/-prefixed ids", () => {
    const tasks = auditTasks(restaurantAudit(), restaurants);
    expect(tasks).toHaveLength(5);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);

    for (const task of tasks) {
      expect(task.id.startsWith("audit/")).toBe(true);
      expect(task.title.trim().length).toBeGreaterThan(0);
      expect(task.description.trim().length).toBeGreaterThan(0);
      expect(task.source).toBe("audit");
      expect(Object.keys(restaurants.channel_weighting)).toContain(task.channel);
      expect(restaurants.channel_weighting[task.channel]).toBeGreaterThan(0);
      expect(Number.isInteger(task.priorityScore)).toBe(true);
      expect(task.effortWeight).toBeGreaterThanOrEqual(1);
      expect(task.effortWeight).toBeLessThanOrEqual(5);
    }
  });

  it("maps module, channel, impact, and automation level fix-by-fix", () => {
    const tasks = auditTasks(restaurantAudit(), restaurants);
    const byId = new Map(tasks.map((t) => [t.id, t]));

    const gbp = byId.get("audit/gbp_completeness/complete-profile")!;
    expect(gbp.module).toBe("M14");
    expect(gbp.channel).toBe("Google Business Profile + local");
    expect(gbp.impact).toBe("critical");
    expect(gbp.automationLevel).toBe("ai_draft_human_approve");
    expect(gbp.priorityScore).toBe(175); // 35 × 4 × 1.25

    const review = byId.get("audit/review_velocity/restart-velocity")!;
    expect(review.module).toBe("M15");
    expect(review.channel).toBe("Reviews (Google/Yelp/TripAdvisor)");
    expect(review.automationLevel).toBe("human_only"); // passthrough, not flattened
    expect(review.priorityScore).toBe(94); // 25 × 3 × 1.25 = 93.75 → 94

    const schema = byId.get("audit/schema_presence_validity/menu-schema")!;
    expect(schema.module).toBe("M10");
    expect(schema.channel).toBe("Menu schema + indexable menu pages");
    expect(schema.priorityScore).toBe(56); // 15 × 3 × 1.25 = 56.25 → 56

    const freshness = byId.get("audit/freshness/stale-menu-page")!;
    expect(freshness.module).toBe("M6"); // re-homed from M13
    expect(freshness.effortWeight).toBe(2);

    const robots = byId.get("audit/ai_crawler_access/unblock-gptbot")!;
    expect(robots.module).toBe("M5"); // re-homed from M13
    expect(robots.priorityScore).toBe(75); // 15 × 4 × 1.25
  });

  it("appends the impact estimate to the task description when present", () => {
    const [task] = auditTasks(audit([fix({ id: "est/1" })]), restaurants);
    expect(task.description).toContain("Menu pages ship no MenuItem JSON-LD.");
    expect(task.description).toContain("High — unlocks AI menu answers");
  });

  it("DROPS M14/M15 fixes for a local-off playbook (ecommerce), keeping the rest", () => {
    const tasks = auditTasks(restaurantAudit(), SEED_PLAYBOOKS.ecommerce);
    const modules = tasks.map((t) => t.module);
    expect(modules).not.toContain("M14");
    expect(modules).not.toContain("M15");
    expect(tasks).toHaveLength(3); // schema + freshness + crawler survive

    const schema = tasks.find((t) => t.module === "M10")!;
    expect(schema.channel).toBe("Product + category schema/content");
    expect(schema.priorityScore).toBe(113); // 30 × 3 × 1.25 = 112.5 → 113
  });

  it("DROPS local fixes when local_module_config.enabled is false, even off-national", () => {
    const insurance = SEED_PLAYBOOKS["health-life-insurance"];
    const disabledLocal: Playbook = {
      ...insurance,
      local_module_config: { ...insurance.local_module_config, enabled: false },
    };
    const tasks = auditTasks(restaurantAudit(), disabledLocal);
    expect(tasks.map((t) => t.module)).not.toContain("M14");
    expect(tasks.map((t) => t.module)).not.toContain("M15");
  });

  it("skips fixes with no resolvable channel anchor (all-zero channel weights)", () => {
    const zeroWeights: Playbook = {
      ...restaurants,
      channel_weighting: { "Meta ads": 0, Local: 0 },
    };
    expect(auditTasks(restaurantAudit(), zeroWeights)).toEqual([]);
  });

  it("scores impact monotonically at a fixed anchor (critical > high > medium > low)", () => {
    const impacts: ImpactLevel[] = ["critical", "high", "medium", "low"];
    const tasks = auditTasks(
      audit(impacts.map((impact) => fix({ id: `mono/${impact}`, impact }))),
      restaurants,
    );
    const scores = tasks.map((t) => t.priorityScore);
    expect(scores).toHaveLength(4);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });

  it("ranks the same impact higher on a heavier channel (channel weighting drives priority)", () => {
    const tasks = auditTasks(
      audit([
        fix({ id: "w/gbp", checkId: "gbp_completeness", module: "M14", impact: "high" }),
        fix({ id: "w/schema", module: "M10", impact: "high" }),
      ]),
      restaurants,
    );
    const gbp = tasks.find((t) => t.id === "audit/w/gbp")!;
    const schema = tasks.find((t) => t.id === "audit/w/schema")!;
    expect(gbp.priorityScore).toBeGreaterThan(schema.priorityScore); // 35-weight beats 15-weight
  });

  it("applies the ×1.25 audit-source boost over the raw channel × impact product", () => {
    const [task] = auditTasks(audit([fix({ id: "boost/1", impact: "critical" })]), restaurants);
    expect(task.priorityScore).toBe(75); // 15 × 4 = 60 unboosted → 75 boosted
  });
});

describe("automation-level invariant (doc 03 §6: anything that publishes = ai_draft_human_approve)", () => {
  it("never emits 'auto' for tasks derived from real aeo-audit output levels", () => {
    // The aeo-audit checks only ever emit ai_draft_human_approve or human_only
    // (verified across src/lib/skills/aeo-audit/checks/) — the merge must
    // preserve that, not widen it.
    const tasks = auditTasks(restaurantAudit(), SEED_PLAYBOOKS.restaurants);
    expect(tasks.length).toBeGreaterThan(0);
    for (const task of tasks) {
      expect(task.automationLevel).not.toBe("auto");
    }
  });

  /**
   * RED — KNOWN SOURCE BUG (reported, do not "fix" the test):
   * `auditTasks` passes `fix.automationLevel` through unclamped. A fix carrying
   * `automationLevel: "auto"` on an on-page-publishing module (M10 schema
   * injection publishes via the auto-fix engine) flows straight into the
   * roadmap as a fully-autonomous publish task — which doc 03 §6 and the
   * RoadmapTask contract ("Anything that publishes = ai_draft_human_approve")
   * prohibit, and which `site_changes` cannot even represent
   * (SiteChangeAutomationLevel excludes "auto"). Today no aeo-audit check emits
   * "auto", so this is unreachable in-system — but generated playbooks (M1b)
   * and future checks make the seam guard load-bearing. The generator must
   * clamp publishing tasks to "ai_draft_human_approve".
   */
  it("clamps a hostile 'auto' level on an on-page publishing fix (M10 schema)", () => {
    const hostile = audit([
      fix({ id: "hostile/auto-schema", module: "M10", automationLevel: "auto" }),
    ]);
    const [task]: RoadmapTask[] = auditTasks(hostile, SEED_PLAYBOOKS.restaurants);
    expect(task.automationLevel).not.toBe("auto");
  });
});
