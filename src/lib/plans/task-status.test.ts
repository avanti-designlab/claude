/**
 * task-status suite — the LEGAL manual-transition logic the plan tab + the
 * updateTaskStatus action share. Pins the sanctioned subset and proves the
 * boundaries the Orchestrator ruled (2026-07-10, "PLAN TAB DEEP BUILD SHIPPED"):
 *   - human_only:              todo ⇄ in_progress AND in_progress ⇄ done
 *   - ai_draft_human_approve:  todo ⇄ in_progress ONLY (work-tracking) — NO done,
 *                              NO pipeline/gate word
 *   - auto:                    no control on any status
 * and that the UI-offered edges are EXACTLY the ones the write CAS re-pins
 * (manualActionsFor ⟷ manualCasFor, one edge table).
 */

import { describe, expect, it } from "vitest";
import { AUTOMATION_LEVELS, TASK_STATUSES } from "@/lib/types/db";
import type { AutomationLevel, TaskStatus } from "@/lib/types/db";
import {
  isLegalManualTarget,
  LEGAL_MANUAL_TARGETS,
  manualActionsFor,
  manualCasFor,
  statusNote,
} from "./task-status";

describe("isLegalManualTarget", () => {
  it("accepts exactly todo + in_progress + done", () => {
    expect(isLegalManualTarget("todo")).toBe(true);
    expect(isLegalManualTarget("in_progress")).toBe(true);
    expect(isLegalManualTarget("done")).toBe(true);
  });
  it("rejects every gate/site-write status and junk", () => {
    for (const bad of ["in_review", "approved", "published", "reverted", "needs_revision", "", "DONE", null, undefined, 3]) {
      expect(isLegalManualTarget(bad)).toBe(false);
    }
  });
});

describe("manualCasFor — the CAS predicates each target implies", () => {
  it("in_progress: sources are BOTH todo (start) and done (reopen); levels are the two non-auto levels", () => {
    const cas = manualCasFor("in_progress");
    expect(cas).not.toBeNull();
    expect([...cas!.sources].sort()).toEqual(["done", "todo"]);
    expect([...cas!.levels].sort()).toEqual(
      ["ai_draft_human_approve", "human_only"],
    );
  });

  it("todo: single source in_progress; legal on both non-auto levels (move-back)", () => {
    const cas = manualCasFor("todo");
    expect(cas!.sources).toEqual(["in_progress"]);
    expect([...cas!.levels].sort()).toEqual(
      ["ai_draft_human_approve", "human_only"],
    );
  });

  it("done: single source in_progress; legal on human_only ONLY (mark done)", () => {
    const cas = manualCasFor("done");
    expect(cas!.sources).toEqual(["in_progress"]);
    expect(cas!.levels).toEqual(["human_only"]);
  });

  it("auto is NEVER in any target's level set", () => {
    for (const target of LEGAL_MANUAL_TARGETS) {
      expect(manualCasFor(target)!.levels).not.toContain("auto");
    }
  });
});

describe("manualActionsFor — human_only owns todo ⇄ in_progress ⇄ done", () => {
  it("human_only todo → the single Start action (→ in_progress)", () => {
    const actions = manualActionsFor("human_only", "todo");
    expect(actions).toHaveLength(1);
    expect(actions[0].to).toBe("in_progress");
    expect(actions[0].label).toBe("Start task");
    expect(actions[0].done).toBeTruthy();
  });

  it("human_only in_progress → TWO controls, FORWARD action leading: mark done, then move back", () => {
    const actions = manualActionsFor("human_only", "in_progress");
    expect(actions).toHaveLength(2);
    // Render order (design mB): "Mark done" leads, "Move back" second.
    expect(actions.map((a) => a.to)).toEqual(["done", "todo"]);
    const byTarget = Object.fromEntries(actions.map((a) => [a.to, a]));
    expect(byTarget.todo.label).toBe("Move back to to-do");
    // "Mark done" must be UNMISTAKABLE and never read as a review approval.
    expect(byTarget.done.label).toBe("Mark done");
    expect(byTarget.done.label).not.toMatch(/approve|publish/i);
  });

  it("human_only done → the single Reopen action (→ in_progress), reversible", () => {
    const actions = manualActionsFor("human_only", "done");
    expect(actions).toHaveLength(1);
    expect(actions[0].to).toBe("in_progress");
    expect(actions[0].label).toBe("Reopen");
  });

  it("human_only in pipeline/gate stages → NO control (unreachable by hand)", () => {
    for (const status of ["in_review", "approved", "published", "reverted"] as const) {
      expect(manualActionsFor("human_only", status)).toEqual([]);
    }
  });
});

describe("manualActionsFor — ai_draft gains todo ⇄ in_progress ONLY (work-tracking)", () => {
  it("ai_draft todo → Start (→ in_progress)", () => {
    const actions = manualActionsFor("ai_draft_human_approve", "todo");
    expect(actions).toHaveLength(1);
    expect(actions[0].to).toBe("in_progress");
  });

  it("ai_draft in_progress → move back ONLY — NEVER 'Mark done'", () => {
    const actions = manualActionsFor("ai_draft_human_approve", "in_progress");
    expect(actions).toHaveLength(1);
    expect(actions[0].to).toBe("todo");
    expect(actions.some((a) => a.to === "done")).toBe(false);
  });

  it("ai_draft offers NO control on done or any pipeline/gate status", () => {
    for (const status of ["done", "in_review", "approved", "published", "reverted"] as const) {
      expect(manualActionsFor("ai_draft_human_approve", status)).toEqual([]);
    }
  });
});

describe("manualActionsFor — the structural refusals (pre-DB, pure)", () => {
  it("auto → NO control on ANY status (machine owned)", () => {
    for (const status of TASK_STATUSES) {
      expect(manualActionsFor("auto", status)).toEqual([]);
    }
  });

  it("'done' is NEVER offered as a target for ai_draft or auto (done ⇒ human_only)", () => {
    for (const level of ["ai_draft_human_approve", "auto"] as const) {
      for (const status of TASK_STATUSES) {
        expect(manualActionsFor(level, status).some((a) => a.to === "done")).toBe(false);
      }
    }
  });

  it("no manual control ever targets a pipeline/gate word, for ANY level/status", () => {
    for (const level of AUTOMATION_LEVELS) {
      for (const status of TASK_STATUSES) {
        for (const action of manualActionsFor(level, status)) {
          expect(["in_review", "approved", "published", "reverted"]).not.toContain(
            action.to,
          );
        }
      }
    }
  });
});

describe("manualActionsFor ⟷ manualCasFor — the UI offers EXACTLY what the CAS accepts", () => {
  it("every offered action round-trips: its target is legal, its source+level are in the CAS set", () => {
    for (const level of AUTOMATION_LEVELS) {
      for (const status of TASK_STATUSES) {
        for (const action of manualActionsFor(level, status)) {
          expect(LEGAL_MANUAL_TARGETS).toContain(action.to);
          const cas = manualCasFor(action.to)!;
          // the status it was offered FROM is a legal CAS source for that target
          expect(cas.sources).toContain(status);
          // and the level it was offered ON is a legal CAS level for that target
          expect(cas.levels).toContain(level);
          // a move never targets its own source (no self-loop)
          expect(cas.sources).not.toContain(action.to);
        }
      }
    }
  });
});

describe("CAS coarsening — every cell the CAS admits beyond the offered edges is DB-unrepresentable", () => {
  // manualCasFor coarsens per target (it unions sources × levels across that
  // target's edges), so the CAS cross-product can admit (level, source) cells no
  // edge offers. That is sound ONLY while every such cell is impossible to
  // occupy in the database — today the 0013 CHECK (done ⇒ human_only). This test
  // converts that comment-level obligation into a red test: a fifth edge that
  // widens the residue beyond DB-unrepresentable cells fails here.
  const dbRepresentable = (level: AutomationLevel, status: TaskStatus) =>
    // Mirror of tasks_done_is_human_only (migration 0013):
    // status <> 'done' OR automation_level = 'human_only'.
    status !== "done" || level === "human_only";

  it("residue is exactly {(ai_draft_human_approve, done) → in_progress}, and the DB CHECK rejects it", () => {
    const uncovered: { to: string; level: AutomationLevel; source: TaskStatus }[] = [];
    for (const to of LEGAL_MANUAL_TARGETS) {
      const cas = manualCasFor(to)!;
      for (const level of cas.levels) {
        for (const source of cas.sources) {
          const offered = manualActionsFor(level, source).some((a) => a.to === to);
          if (!offered) {
            uncovered.push({ to, level, source });
            // The coarsened CAS would accept this cell — it must be a row shape
            // the database cannot hold.
            expect(
              dbRepresentable(level, source),
              `CAS admits unoffered cell (${level}, ${source} → ${to}) that a real row CAN occupy — the coarsening is no longer sound`,
            ).toBe(false);
          }
        }
      }
    }
    // Pin the exact residue so any widening is loud, not silently absorbed.
    expect(uncovered).toEqual([
      { to: "in_progress", level: "ai_draft_human_approve", source: "done" },
    ]);
  });
});

describe("statusNote — an honest ownership/limit note for EVERY task (Design M2)", () => {
  it("is total: every automation level carries a non-empty note", () => {
    for (const level of AUTOMATION_LEVELS) {
      expect(statusNote(level).length).toBeGreaterThan(0);
    }
  });

  it("names the system for auto", () => {
    expect(statusNote("auto")).toMatch(/automatically/i);
  });

  it("ai_draft: names work-tracking, the review queue, AND the pipeline reconcile (wiring-time condition)", () => {
    const note = statusNote("ai_draft_human_approve");
    expect(note).toMatch(/started/i); // work-tracking
    expect(note).toMatch(/review queue/i); // content decisions live there
    expect(note).toMatch(/reconcile/i); // the recorded wiring-time condition
    expect(note).toMatch(/pipeline/i);
  });

  it("human_only: names done as work-tracking that is NOT an approval, and drops the stale 'coming' promise", () => {
    const note = statusNote("human_only");
    expect(note).toMatch(/done/i);
    expect(note).toMatch(/approval/i); // never stands in for a review/change approval
    // 0013 landed — the old "marking complete is coming" copy is now false.
    expect(note).not.toMatch(/coming/i);
  });
});
