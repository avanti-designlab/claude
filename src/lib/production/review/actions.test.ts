/**
 * R3 review-lifecycle server-action suite. Only the seams are mocked (verified
 * claims reader, Supabase client, next/navigation redirect); the guards, uuid
 * clamps, the REAL transition/gate engine, and the real persist patch all run.
 * Pins: transition legality (every illegal transition refused), the strengthened
 * approval gate + humanization exemptions at the action layer, verdicts bound to
 * the row's body_hash, approver/reviewer resolved from claims (never supplied),
 * demote-before-edit, RLS-mirrored auth, and redacted telemetry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import {
  approveContentItem,
  recordComplianceVerdict,
  recordQualityVerdict,
  resubmitContentItem,
  reviseContentDraft,
  sendBackContentItem,
} from "./actions";

const { getClaimsMock, createClientMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getClaims: getClaimsMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const MEMBER_ID = "22222222-2222-4222-8222-222222222222";
const HASH = "hash-abc";
const OPERATOR = { tenantId: "t1", role: "operator" as const, sub: "sub-1" };
const VIEWER = { tenantId: "t1", role: "client_viewer" as const, clientId: ITEM_ID, sub: "sub-3" };

const TELEMETRY = /^\[review-write-failure\] stage=[a-z_]+ code=[A-Za-z0-9_]{1,16}$/;

const pass = (bodyHash = HASH) => ({ passed: true, body_hash: bodyHash });

/** A content_items row for readReviewRow (only the review columns). */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM_ID,
    status: "in_review",
    type: "blog",
    automation_level: "ai_draft_human_approve",
    body_hash: HASH,
    humanization: { humanized: true, detection_score: 0.1, passes: true },
    quality_review: pass(),
    compliance_review: pass(),
    ...overrides,
  };
}

/** Script: content_items read (+ optional update), tenant_users member read. */
function script(reviewRow: Record<string, unknown> | null, updateResult: unknown = { id: ITEM_ID, status: "in_review" }): FakeScript {
  return {
    content_items: {
      select: { data: reviewRow },
      update: updateResult === "error" ? { error: { message: "x", code: "23514" } } : { data: updateResult },
    },
    tenant_users: { select: { data: { id: MEMBER_ID } } },
  };
}

function setup(s: FakeScript, claims: unknown = OPERATOR) {
  const fake = fakePostgrest(s);
  getClaimsMock.mockResolvedValue(claims);
  createClientMock.mockResolvedValue(fake.client);
  return fake;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

describe("recordQualityVerdict / recordComplianceVerdict", () => {
  it("stamps the verdict with passed + the ROW's body_hash + reviewer from claims (never synthesized)", async () => {
    const fake = setup(script(row(), { id: ITEM_ID, status: "in_review" }));
    const res = await recordQualityVerdict({ contentItemId: ITEM_ID, passed: true, note: "looks good" });
    expect(res).toEqual({ ok: true, status: "in_review" });

    const patch = fake.updates[0].values as { quality_review: Record<string, unknown> };
    expect(patch.quality_review.passed).toBe(true);
    expect(patch.quality_review.body_hash).toBe(HASH); // bound to the row, not caller input
    expect(patch.quality_review.reviewed_by).toBe(MEMBER_ID); // from claims, not supplied
    expect(patch.quality_review.note).toBe("looks good");
    expect(fake.updates[0].filters).toEqual({ tenant_id: "t1", id: ITEM_ID });
  });

  it("records a FAILING verdict verbatim (does not flip the gate's decision)", async () => {
    const fake = setup(script(row()));
    await recordComplianceVerdict({ contentItemId: ITEM_ID, passed: false });
    const patch = fake.updates[0].values as { compliance_review: { passed: boolean } };
    expect(patch.compliance_review.passed).toBe(false);
  });

  it("refuses a verdict when the item is NOT in_review (illegal transition)", async () => {
    setup(script(row({ status: "draft" })));
    const res = await recordQualityVerdict({ contentItemId: ITEM_ID, passed: true });
    expect(res).toEqual({ ok: false, reason: "illegal_transition", error: expect.any(String) });
  });

  it("refuses a non-boolean passed (invalid input)", async () => {
    setup(script(row()));
    const res = await recordQualityVerdict({ contentItemId: ITEM_ID, passed: "yes" as unknown as boolean });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("invalid_input");
  });
});

describe("approveContentItem — the human approval act", () => {
  it("approves from in_review, stamping approved_by from claims + a server approved_at", async () => {
    const fake = setup(script(row(), { id: ITEM_ID, status: "approved" }));
    const res = await approveContentItem({ contentItemId: ITEM_ID });
    expect(res).toEqual({ ok: true, status: "approved" });
    const patch = fake.updates[0].values as { status: string; approved_by: string; approved_at: string };
    expect(patch.status).toBe("approved");
    expect(patch.approved_by).toBe(MEMBER_ID);
    expect(typeof patch.approved_at).toBe("string");
  });

  it("refuses when quality not passed / stale / humanization missing (not_ready)", async () => {
    setup(script(row({ quality_review: { passed: false, body_hash: HASH } })));
    expect((await approveContentItem({ contentItemId: ITEM_ID })).ok).toBe(false);

    setup(script(row({ quality_review: pass("STALE") })));
    const stale = await approveContentItem({ contentItemId: ITEM_ID });
    expect(stale).toMatchObject({ ok: false, reason: "not_ready" });

    setup(script(row({ humanization: null })));
    const noHuman = await approveContentItem({ contentItemId: ITEM_ID });
    expect(noHuman).toMatchObject({ ok: false, reason: "not_ready" });
  });

  it("approves a schema_copy with NO humanization (exemption); a blog cannot", async () => {
    setup(script(row({ type: "schema_copy", humanization: null }), { id: ITEM_ID, status: "approved" }));
    expect((await approveContentItem({ contentItemId: ITEM_ID })).ok).toBe(true);
  });

  it("never approves from draft (illegal transition — no write attempted)", async () => {
    const fake = setup(script(row({ status: "draft" })));
    const res = await approveContentItem({ contentItemId: ITEM_ID });
    expect(res).toMatchObject({ ok: false, reason: "illegal_transition" });
    expect(fake.updates).toHaveLength(0);
  });

  it("a DB-CHECK rejection at write time surfaces as write_failed with redacted telemetry", async () => {
    setup(script(row(), "error"));
    const res = await approveContentItem({ contentItemId: ITEM_ID });
    expect(res).toMatchObject({ ok: false, reason: "write_failed" });
    const line = consoleErrorSpy.mock.calls.at(-1)?.[0] as string;
    expect(line).toMatch(TELEMETRY);
    expect(line).not.toContain(HASH);
  });
});

describe("sendBack / resubmit", () => {
  it("send-back records a FAILING gate verdict with the reason + demotes to needs_revision", async () => {
    const fake = setup(script(row(), { id: ITEM_ID, status: "needs_revision" }));
    const res = await sendBackContentItem({ contentItemId: ITEM_ID, gate: "compliance", reason: "add the disclaimer" });
    expect(res).toEqual({ ok: true, status: "needs_revision" });
    const patch = fake.updates[0].values as { status: string; compliance_review: { passed: boolean; note: string; body_hash: string } };
    expect(patch.status).toBe("needs_revision");
    expect(patch.compliance_review.passed).toBe(false);
    expect(patch.compliance_review.note).toBe("add the disclaimer");
    expect(patch.compliance_review.body_hash).toBe(HASH);
  });

  it("send-back requires a reason and a valid gate", async () => {
    setup(script(row()));
    expect((await sendBackContentItem({ contentItemId: ITEM_ID, gate: "quality", reason: "  " })).ok).toBe(false);
    setup(script(row()));
    expect((await sendBackContentItem({ contentItemId: ITEM_ID, gate: "nope" as unknown as "quality", reason: "x" })).ok).toBe(false);
  });

  it("resubmit moves needs_revision → in_review; refuses from any other state", async () => {
    setup(script(row({ status: "needs_revision" }), { id: ITEM_ID, status: "in_review" }));
    expect(await resubmitContentItem({ contentItemId: ITEM_ID })).toEqual({ ok: true, status: "in_review" });

    setup(script(row({ status: "draft" })));
    expect((await resubmitContentItem({ contentItemId: ITEM_ID })).ok).toBe(false);
  });
});

describe("reviseContentDraft — demote-before-edit", () => {
  it("editing an APPROVED row demotes it to needs_revision and writes the new body", async () => {
    const fake = setup(script(row({ status: "approved" }), { id: ITEM_ID, status: "needs_revision" }));
    const res = await reviseContentDraft({ contentItemId: ITEM_ID, body: "revised body" });
    expect(res).toEqual({ ok: true, status: "needs_revision" });
    const patch = fake.updates[0].values as { body: string; status: string };
    expect(patch.body).toBe("revised body");
    expect(patch.status).toBe("needs_revision");
  });

  it("a draft edit stays a draft; a title can be cleared to null", async () => {
    const fake = setup(script(row({ status: "draft" }), { id: ITEM_ID, status: "draft" }));
    await reviseContentDraft({ contentItemId: ITEM_ID, title: null });
    const patch = fake.updates[0].values as { title: string | null; status: string };
    expect(patch.title).toBeNull();
    expect(patch.status).toBe("draft");
  });

  it("published content cannot be edited here (illegal)", async () => {
    const fake = setup(script(row({ status: "published" })));
    const res = await reviseContentDraft({ contentItemId: ITEM_ID, body: "x" });
    expect(res).toMatchObject({ ok: false, reason: "illegal_transition" });
    expect(fake.updates).toHaveLength(0);
  });

  it("nothing to change → invalid input", async () => {
    setup(script(row({ status: "draft" })));
    expect((await reviseContentDraft({ contentItemId: ITEM_ID })).ok).toBe(false);
  });
});

describe("authorization + membership + not-found", () => {
  it("a client_viewer is forbidden from every write (RLS-mirrored guard)", async () => {
    setup(script(row()), VIEWER);
    expect((await approveContentItem({ contentItemId: ITEM_ID })).ok).toBe(false);
    setup(script(row()), VIEWER);
    const r = await recordQualityVerdict({ contentItemId: ITEM_ID, passed: true });
    expect(r).toMatchObject({ ok: false, reason: "forbidden" });
  });

  it("a bad uuid and a null row both come back not_found (parity)", async () => {
    setup(script(row()));
    expect((await approveContentItem({ contentItemId: "not-a-uuid" })).ok).toBe(false);
    setup(script(null));
    expect(await approveContentItem({ contentItemId: ITEM_ID })).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("no tenant_users membership → no_membership (fail closed; nothing written)", async () => {
    const fake = setup({
      content_items: { select: { data: row() }, update: { data: { id: ITEM_ID, status: "approved" } } },
      tenant_users: { select: { data: null } },
    });
    const res = await approveContentItem({ contentItemId: ITEM_ID });
    expect(res).toMatchObject({ ok: false, reason: "no_membership" });
    expect(fake.updates).toHaveLength(0);
  });
});
