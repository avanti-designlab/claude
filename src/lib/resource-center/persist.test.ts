/**
 * M18 — persistence-or-flagged-gap. The frozen F1 schema has no home for a Q&A
 * exchange, so persistence is an honest NO-OP that writes nothing and returns the
 * greppable gap flag (M3/M4/M15 precedent). It takes no Supabase client + no
 * tenant, so it can never be mistaken for a real write path.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { persistResourceAnswer, RESOURCE_CENTER_PERSISTENCE_GAP } from "./persist";

describe("persistResourceAnswer (no frozen-schema home → flagged gap)", () => {
  it("writes nothing and returns the not_persisted outcome with the gap flag", () => {
    const out = persistResourceAnswer();
    expect(out).toEqual({
      kind: "not_persisted",
      reason: "no_table",
      flag: RESOURCE_CENTER_PERSISTENCE_GAP,
    });
  });

  it("takes no arguments — it cannot receive (or leak) a client, tenant, or question", () => {
    expect(persistResourceAnswer).toHaveLength(0);
  });

  it("the gap flag names the frozen migrations + the post-freeze path (greppable)", () => {
    expect(RESOURCE_CENTER_PERSISTENCE_GAP).toMatch(/migrations 0001–0008/);
    expect(RESOURCE_CENTER_PERSISTENCE_GAP).toMatch(/post-freeze/i);
    // It must NOT quietly claim a wrong-table home.
    expect(RESOURCE_CENTER_PERSISTENCE_GAP).toMatch(/NOT persisted|not persisted/);
  });
});
