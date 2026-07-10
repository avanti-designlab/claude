/**
 * Onboarding save-flow logic suite (pure module — no React, no DOM).
 *
 * Pins the display contract for `createClientFromOnboarding`'s result:
 *  - the three ok-outcomes the plan step renders (plan persisted / no active
 *    playbook / plan write failed) map exactly per the action's contract
 *  - the roadmap carried into "saved" state is the SERVER'S object, untouched
 *  - step 4 reveals only when BOTH the assembling beat and the server write
 *    have resolved — the animation covers the real await and holds if the
 *    write outlasts it.
 */

import { describe, expect, it } from "vitest";
import type {
  CreateClientResult,
  CreatedClient,
  CreatedPlan,
} from "@/lib/clients/actions";
import type { PersistedProperty } from "@/lib/clients/properties";
import type { GeneratedRoadmap } from "@/lib/types/roadmap";
import {
  isSettled,
  planOutcome,
  SAVE_ERROR_HEADING,
  SAVE_UNREACHABLE,
  saveErrorBody,
  shouldReveal,
  toSaveState,
  websitePersisted,
  type SaveState,
} from "./save-outcome";

const client: CreatedClient = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Gable & Grove Realty",
  vertical: "real-estate",
  status: "onboarding",
};

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

const property: PersistedProperty = {
  id: "33333333-3333-3333-3333-333333333333",
  url: "https://gableandgrove.example",
  platform: "wordpress",
};

describe("toSaveState", () => {
  it("maps ok:false to an error carrying the server's interface-voice message", () => {
    const result: CreateClientResult = { ok: false, error: "Nope — try again." };
    expect(toSaveState(result)).toEqual({
      phase: "error",
      message: "Nope — try again.",
    });
  });

  it("maps ok:true with a plan to saved, carrying the SERVER'S roadmap object untouched", () => {
    const state = toSaveState({ ok: true, client, plan });
    expect(state.phase).toBe("saved");
    if (state.phase !== "saved") throw new Error("unreachable");
    expect(state.client).toBe(client);
    // Referential identity: the displayed roadmap IS the persisted one.
    expect(state.plan?.roadmap).toBe(roadmap);
    expect(state.planWarning).toBeUndefined();
  });

  it("maps ok:true with plan null (+ optional warning) to saved, preserving the warning", () => {
    const noPlaybook = toSaveState({ ok: true, client, plan: null });
    expect(noPlaybook).toEqual({
      phase: "saved",
      client,
      plan: null,
      planWarning: undefined,
    });

    const failed = toSaveState({
      ok: true,
      client,
      plan: null,
      planWarning: "Your client was saved, but we couldn’t generate the plan.",
    });
    if (failed.phase !== "saved") throw new Error("unreachable");
    expect(failed.planWarning).toMatch(/client was saved/);
  });
});

describe("website property threading (remediation A6 — toSaveState carries the outcome verbatim)", () => {
  it("ABSENT property (older callers / no website sent) stays undefined — never mistaken for a save", () => {
    const state = toSaveState({ ok: true, client, plan });
    if (state.phase !== "saved") throw new Error("unreachable");
    expect(state.property).toBeUndefined();
    expect(state.propertyWarning).toBeUndefined();
    expect(websitePersisted(state.property, state.propertyWarning)).toBe(false);
  });

  it("NULL property + warning (entered but not saved) threads through — warning verbatim, not a save", () => {
    const warning =
      "Your client was saved, but we couldn’t save their website — add it from the client’s Properties once you’re in.";
    const state = toSaveState({
      ok: true,
      client,
      plan,
      property: null,
      propertyWarning: warning,
    });
    if (state.phase !== "saved") throw new Error("unreachable");
    expect(state.property).toBeNull();
    // VERBATIM copy-through: the server's interface-voice string, untouched.
    expect(state.propertyWarning).toBe(warning);
    expect(websitePersisted(state.property, state.propertyWarning)).toBe(false);
  });

  it("persisted property threads through as the SERVER'S object, and counts as saved", () => {
    const state = toSaveState({ ok: true, client, plan, property });
    if (state.phase !== "saved") throw new Error("unreachable");
    expect(state.property).toBe(property);
    expect(websitePersisted(state.property, state.propertyWarning)).toBe(true);
  });
});

describe("websitePersisted (the finish screen's 'their website is saved' gate)", () => {
  it("undefined → false (no website was sent)", () => {
    expect(websitePersisted(undefined)).toBe(false);
  });

  it("null → false (entered but not saved)", () => {
    expect(websitePersisted(null)).toBe(false);
  });

  it("warning present ⇒ false, even alongside a property object — a warning always wins", () => {
    expect(websitePersisted(property, "soft-fail warning")).toBe(false);
  });

  it("property with no warning → true", () => {
    expect(websitePersisted(property)).toBe(true);
    expect(websitePersisted(property, undefined)).toBe(true);
  });
});

describe("planOutcome (the three ok-outcomes on the plan step)", () => {
  it("plan persisted → 'plan'", () => {
    expect(planOutcome(plan)).toBe("plan");
    // A warning never accompanies a persisted plan per the contract, but the
    // plan's presence wins regardless.
    expect(planOutcome(plan, "stray warning")).toBe("plan");
  });

  it("plan null without warning → 'no-playbook' (legit state, nothing failed)", () => {
    expect(planOutcome(null)).toBe("no-playbook");
    expect(planOutcome(null, undefined)).toBe("no-playbook");
  });

  it("plan null WITH warning → 'plan-write-failed' (client saved, non-fatal)", () => {
    expect(planOutcome(null, "Your client was saved, but…")).toBe(
      "plan-write-failed"
    );
  });
});

describe("shouldReveal (assembling beat covers the real await)", () => {
  const saving: SaveState = { phase: "saving" };
  const saved: SaveState = { phase: "saved", client, plan };
  const errored: SaveState = { phase: "error", message: "x" };

  it("holds while the write is in flight, even after the timer finishes", () => {
    expect(shouldReveal(false, true, saving)).toBe(false);
    expect(shouldReveal(true, false, saving)).toBe(false); // reduced motion too
  });

  it("holds while the timer runs, even after the write resolves", () => {
    expect(shouldReveal(false, false, saved)).toBe(false);
  });

  it("reveals once both settle — for saved AND error results", () => {
    expect(shouldReveal(false, true, saved)).toBe(true);
    expect(shouldReveal(false, true, errored)).toBe(true);
  });

  it("under reduced motion the timer is skipped; only the write gates", () => {
    expect(shouldReveal(true, false, saved)).toBe(true);
    expect(shouldReveal(true, false, errored)).toBe(true);
  });

  it("an idle save never reveals (nothing to show)", () => {
    expect(isSettled({ phase: "idle" })).toBe(false);
    expect(shouldReveal(true, true, { phase: "idle" })).toBe(false);
  });
});

describe("SAVE_UNREACHABLE (honest lost-response copy — Code Review 2026-07-09, Major 1)", () => {
  it("never claims nothing was created (a lost response can hide a landed save)", () => {
    expect(SAVE_UNREACHABLE).not.toMatch(/nothing was created/i);
  });

  it("says what we know: unconfirmed, retry-safe, no duplicates — in interface voice", () => {
    expect(SAVE_UNREACHABLE).toBe(
      "We couldn’t confirm the save — check your connection and try again. If it already went through, retrying won’t create a duplicate."
    );
    // Typographic apostrophes only (doc 06 §6 interface voice).
    expect(SAVE_UNREACHABLE).not.toContain("'");
  });
});

describe("saveErrorBody (step-4 error-panel heading dedupe)", () => {
  it("trims the heading sentence from server strings that open with it", () => {
    expect(
      saveErrorBody(
        `${SAVE_ERROR_HEADING}. Check your connection and try again.`
      )
    ).toBe("Check your connection and try again.");
  });

  it("renders other server errors verbatim (e.g. permissions)", () => {
    const message = "Only an agency admin can onboard clients.";
    expect(saveErrorBody(message)).toBe(message);
  });

  it("renders SAVE_UNREACHABLE verbatim — the new copy no longer opens with the heading and must never be truncated", () => {
    expect(SAVE_UNREACHABLE.startsWith(SAVE_ERROR_HEADING)).toBe(false);
    expect(saveErrorBody(SAVE_UNREACHABLE)).toBe(SAVE_UNREACHABLE);
  });
});
