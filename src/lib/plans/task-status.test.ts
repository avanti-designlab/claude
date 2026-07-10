/**
 * task-status suite — the LEGAL manual-transition logic the plan tab + the
 * updateTaskStatus action share. Pins the sanctioned subset (human_only,
 * todo⇄in_progress) and proves that every other automation level / status
 * offers no control (the boundary flagged to the Orchestrator stays closed).
 */

import { describe, expect, it } from "vitest";
import { AUTOMATION_LEVELS, TASK_STATUSES } from "@/lib/types/db";
import {
  isLegalManualTarget,
  LEGAL_MANUAL_TARGETS,
  manualActionsFor,
  requiredSourceFor,
  statusNote,
} from "./task-status";

describe("isLegalManualTarget", () => {
  it("accepts exactly todo + in_progress", () => {
    expect(isLegalManualTarget("todo")).toBe(true);
    expect(isLegalManualTarget("in_progress")).toBe(true);
  });
  it("rejects every gate/site-write status and junk", () => {
    for (const bad of ["in_review", "approved", "published", "reverted", "", "TODO", null, undefined, 3]) {
      expect(isLegalManualTarget(bad)).toBe(false);
    }
  });
});

describe("requiredSourceFor — the CAS source each target implies", () => {
  it("in_progress requires todo; todo requires in_progress", () => {
    expect(requiredSourceFor("in_progress")).toBe("todo");
    expect(requiredSourceFor("todo")).toBe("in_progress");
  });
});

describe("manualActionsFor — only human_only, only the todo⇄in_progress edge", () => {
  it("human_only todo → the single Start action (→ in_progress)", () => {
    const actions = manualActionsFor("human_only", "todo");
    expect(actions).toHaveLength(1);
    expect(actions[0].to).toBe("in_progress");
    expect(actions[0].label).toBeTruthy();
    expect(actions[0].done).toBeTruthy();
  });

  it("human_only in_progress → the single move-back action (→ todo)", () => {
    const actions = manualActionsFor("human_only", "in_progress");
    expect(actions).toHaveLength(1);
    expect(actions[0].to).toBe("todo");
  });

  it("human_only in later stages → NO control (completion is flagged, not built)", () => {
    for (const status of ["in_review", "approved", "published", "reverted"] as const) {
      expect(manualActionsFor("human_only", status)).toEqual([]);
    }
  });

  it("auto + ai_draft_human_approve → NO control on ANY status (machine/pipeline owned)", () => {
    for (const level of ["auto", "ai_draft_human_approve"] as const) {
      for (const status of TASK_STATUSES) {
        expect(manualActionsFor(level, status)).toEqual([]);
      }
    }
  });

  it("every offered target is inside the legal set", () => {
    for (const level of AUTOMATION_LEVELS) {
      for (const status of TASK_STATUSES) {
        for (const action of manualActionsFor(level, status)) {
          expect(LEGAL_MANUAL_TARGETS).toContain(action.to);
          // and the CAS source it implies is never the target itself
          expect(requiredSourceFor(action.to)).not.toBe(action.to);
        }
      }
    }
  });
});

describe("statusNote — an honest ownership/limit note for EVERY task (Design M2)", () => {
  it("is total: every automation level carries a non-empty note", () => {
    for (const level of AUTOMATION_LEVELS) {
      expect(statusNote(level).length).toBeGreaterThan(0);
    }
  });

  it("names the system for auto, the pipeline for ai_draft", () => {
    expect(statusNote("auto")).toMatch(/automatically/i);
    expect(statusNote("ai_draft_human_approve")).toMatch(/pipeline|review queue/i);
  });

  it("discloses the completion gap on human_only — alongside the control, honest-for-now", () => {
    // The note renders WITH the todo/in_progress control (not only where no
    // control exists): completion (`done`, migration 0013) is coming, and until
    // it lands the UI says so instead of hiding it.
    expect(statusNote("human_only")).toMatch(/coming/i);
    expect(statusNote("human_only")).toMatch(/started/i);
  });
});
