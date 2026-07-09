/**
 * Display-contract suite for the dashboard's "Generate plan" control (pure
 * module — no React, no DOM). Pins:
 *  - which cards get the control: live verticals only (ACTIVE_VERTICALS is
 *    the single source — the same one onboarding's step-industry reads);
 *  - BOTH ok variants land as a refresh — alreadyExisted:true is a success
 *    (the plan appears), never error theater;
 *  - every ok:false variant surfaces the backend's error STRING verbatim —
 *    the string is the display truth, `reason` never drives copy.
 */

import { describe, expect, it } from "vitest";
import type { CreatedPlan } from "@/lib/clients/actions";
import type { RegeneratePlanResult } from "@/lib/plans/actions";
import type { GeneratedRoadmap } from "@/lib/types/roadmap";
import {
  isLiveVertical,
  planRowVariant,
  toGeneratePlanOutcome,
} from "./generate-plan-outcome";

const roadmap: GeneratedRoadmap = {
  vertical: "real-estate",
  playbookVersion: "1.0.0",
  generatedAt: "2026-07-09T00:00:00.000Z",
  channelAllocation: { "google-seo": 1 },
  tasks: [],
  summary: "One channel, one task.",
};

const plan: CreatedPlan = {
  id: "22222222-2222-2222-2222-222222222222",
  playbookVersion: "1.0.0",
  taskCount: 12,
  roadmap,
};

describe("isLiveVertical (which cards get the control)", () => {
  it("real estate is live (Gate 1a — the one active vertical)", () => {
    expect(isLiveVertical("real-estate")).toBe(true);
  });

  it("dormant seed verticals and unknown strings are not", () => {
    expect(isLiveVertical("restaurants")).toBe(false);
    expect(isLiveVertical("cannabis")).toBe(false);
    expect(isLiveVertical("not-a-vertical")).toBe(false);
    expect(isLiveVertical("")).toBe(false);
  });
});

describe("planRowVariant (which Plan row a client card renders)", () => {
  const admin = "agency_admin" as const;

  it("a healthy plan (tasks > 0) shows its version — every role, every vertical", () => {
    for (const role of ["agency_admin", "operator", "client_viewer"] as const) {
      expect(
        planRowVariant({ role, vertical: "real-estate", hasPlan: true, taskCount: 12 })
      ).toBe("version");
      expect(
        planRowVariant({ role, vertical: "restaurants", hasPlan: true, taskCount: 3 })
      ).toBe("version");
    }
  });

  it("agency_admin + live vertical + plan-less → the control", () => {
    expect(
      planRowVariant({ role: admin, vertical: "real-estate", hasPlan: false, taskCount: 0 })
    ).toBe("generate");
  });

  it("agency_admin + live vertical + ZERO-TASK RESIDUE plan → the control (design review Major 3: the supersede path is idempotent and clears residue)", () => {
    expect(
      planRowVariant({ role: admin, vertical: "real-estate", hasPlan: true, taskCount: 0 })
    ).toBe("generate");
  });

  it("roles the action rejects never see the control (Code Review minor 4) — quiet rows instead", () => {
    for (const role of ["operator", "client_viewer"] as const) {
      expect(
        planRowVariant({ role, vertical: "real-estate", hasPlan: false, taskCount: 0 })
      ).toBe("none");
      // Residue plan: they keep the version row, not a button that errors.
      expect(
        planRowVariant({ role, vertical: "real-estate", hasPlan: true, taskCount: 0 })
      ).toBe("version");
    }
  });

  it("a null role (no verified claim) fails closed — no control", () => {
    expect(
      planRowVariant({ role: null, vertical: "real-estate", hasPlan: false, taskCount: 0 })
    ).toBe("none");
  });

  it("dormant verticals never get the control, even for agency_admin", () => {
    expect(
      planRowVariant({ role: admin, vertical: "restaurants", hasPlan: false, taskCount: 0 })
    ).toBe("none");
    expect(
      planRowVariant({ role: admin, vertical: "cannabis", hasPlan: true, taskCount: 0 })
    ).toBe("version");
  });
});

describe("toGeneratePlanOutcome", () => {
  it("ok with a fresh plan → refresh (the numbers speak)", () => {
    const result: RegeneratePlanResult = { ok: true, plan, alreadyExisted: false };
    expect(toGeneratePlanOutcome(result)).toEqual({ kind: "refresh" });
  });

  it("ok with an already-existing plan → the SAME refresh (no error theater)", () => {
    const result: RegeneratePlanResult = { ok: true, plan, alreadyExisted: true };
    expect(toGeneratePlanOutcome(result)).toEqual({ kind: "refresh" });
  });

  it("every failure reason → the backend's error string VERBATIM", () => {
    const reasons = ["no_playbook", "not_found", "write_failed"] as const;
    for (const reason of reasons) {
      const result: RegeneratePlanResult = {
        ok: false,
        reason,
        error: `The server's exact words for ${reason}.`,
      };
      expect(toGeneratePlanOutcome(result)).toEqual({
        kind: "error",
        message: `The server's exact words for ${reason}.`,
      });
    }
  });
});
