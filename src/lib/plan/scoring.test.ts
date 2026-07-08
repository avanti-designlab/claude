/**
 * Priority scoring + deterministic ordering tests (M1 plan generator · Phase 1.1).
 *
 * Doc 02 rule under test: channel_weighting drives the roadmap — effort follows
 * where the vertical builds authority, never an even distribution. That means
 * priorityScore must be monotonic in BOTH channel weight and impact, and the
 * sort must be a total order (same inputs → identical roadmap, no ties left to
 * engine/insertion order).
 */

import { describe, expect, it } from "vitest";
import {
  IMPACT_FACTOR,
  IMPACT_RANK,
  effortForImpact,
  priorityScore,
  sortTasks,
} from "./scoring";
import type { ImpactLevel, RoadmapTask } from "@/lib/types/roadmap";

const IMPACTS: ImpactLevel[] = ["critical", "high", "medium", "low"];

function task(overrides: Partial<RoadmapTask> & Pick<RoadmapTask, "id">): RoadmapTask {
  return {
    title: "task",
    description: "desc",
    module: "M8",
    channel: "On-site resource center (pillars + FAQ + video)",
    source: "playbook",
    impact: "medium",
    priorityScore: 10,
    effortWeight: 2,
    automationLevel: "ai_draft_human_approve",
    ...overrides,
  };
}

describe("impact factors", () => {
  it("are strictly monotonic: critical > high > medium > low", () => {
    expect(IMPACT_FACTOR.critical).toBeGreaterThan(IMPACT_FACTOR.high);
    expect(IMPACT_FACTOR.high).toBeGreaterThan(IMPACT_FACTOR.medium);
    expect(IMPACT_FACTOR.medium).toBeGreaterThan(IMPACT_FACTOR.low);
  });

  it("rank critical first for sorting", () => {
    expect(IMPACT_RANK.critical).toBeLessThan(IMPACT_RANK.high);
    expect(IMPACT_RANK.high).toBeLessThan(IMPACT_RANK.medium);
    expect(IMPACT_RANK.medium).toBeLessThan(IMPACT_RANK.low);
  });

  it("effortForImpact is monotonic (heavier fixes for heavier impact)", () => {
    expect(IMPACTS.map(effortForImpact)).toEqual([4, 3, 2, 1]);
  });
});

describe("priorityScore", () => {
  it("is higher for a higher-weight channel at the same impact (doc 02: effort follows authority)", () => {
    for (const impact of IMPACTS) {
      expect(priorityScore(35, impact)).toBeGreaterThan(priorityScore(15, impact));
    }
  });

  it("is strictly monotonic in impact at a fixed channel weight", () => {
    const scores = IMPACTS.map((impact) => priorityScore(30, impact));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(scores).size).toBe(scores.length);
  });

  it("computes weight × impact factor × multiplier, rounded", () => {
    expect(priorityScore(30, "medium")).toBe(60); // default multiplier 1
    expect(priorityScore(15, "high", 1.25)).toBe(56); // 56.25 → 56
    expect(priorityScore(25, "high", 1.25)).toBe(94); // 93.75 → 94
  });
});

describe("sortTasks — deterministic total order", () => {
  it("orders by priorityScore desc first", () => {
    const sorted = sortTasks([
      task({ id: "low", priorityScore: 10 }),
      task({ id: "high", priorityScore: 175 }),
      task({ id: "mid", priorityScore: 56 }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["high", "mid", "low"]);
  });

  it("breaks score ties by impact (critical first)", () => {
    const sorted = sortTasks([
      task({ id: "b", priorityScore: 50, impact: "low" }),
      task({ id: "a", priorityScore: 50, impact: "critical" }),
      task({ id: "c", priorityScore: 50, impact: "high" }),
    ]);
    expect(sorted.map((t) => t.impact)).toEqual(["critical", "high", "low"]);
  });

  it("breaks score+impact ties by module, then id", () => {
    const sorted = sortTasks([
      task({ id: "z", priorityScore: 50, module: "M8" }),
      task({ id: "a", priorityScore: 50, module: "M8" }),
      task({ id: "m", priorityScore: 50, module: "M5" }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual(["m", "a", "z"]);
  });

  it("is deterministic: reversed input yields the identical roadmap order", () => {
    const tasks = [
      task({ id: "a", priorityScore: 94, impact: "high" }),
      task({ id: "b", priorityScore: 94, impact: "critical" }),
      task({ id: "c", priorityScore: 175, impact: "critical" }),
      task({ id: "d", priorityScore: 94, impact: "critical", module: "M5" }),
      task({ id: "e", priorityScore: 19, impact: "low" }),
    ];
    const forward = sortTasks(tasks).map((t) => t.id);
    const backward = sortTasks([...tasks].reverse()).map((t) => t.id);
    expect(backward).toEqual(forward);
  });

  it("does not mutate its input", () => {
    const tasks = [task({ id: "b", priorityScore: 1 }), task({ id: "a", priorityScore: 99 })];
    const before = tasks.map((t) => t.id);
    sortTasks(tasks);
    expect(tasks.map((t) => t.id)).toEqual(before);
  });
});
