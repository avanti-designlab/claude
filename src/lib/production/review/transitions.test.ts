import { describe, expect, it } from "vitest";
import { CONTENT_ITEM_STATUSES, type ContentItemStatus } from "@/lib/types/db";
import {
  canApprove,
  canRecordVerdict,
  canResubmit,
  canSendBack,
  evaluateApprovalGate,
  humanizationRequired,
  reviseTargetStatus,
} from "./transitions";

const STATUSES = CONTENT_ITEM_STATUSES;
const others = (allow: ContentItemStatus[]) =>
  STATUSES.filter((s) => !allow.includes(s));

describe("content lifecycle transition legality (every legal + illegal edge pinned)", () => {
  it("verdicts may be recorded ONLY from in_review", () => {
    expect(canRecordVerdict("in_review")).toBe(true);
    for (const s of others(["in_review"])) expect(canRecordVerdict(s)).toBe(false);
  });

  it("approve is legal ONLY from in_review", () => {
    expect(canApprove("in_review")).toBe(true);
    for (const s of others(["in_review"])) expect(canApprove(s)).toBe(false);
  });

  it("send-back is legal ONLY from in_review", () => {
    expect(canSendBack("in_review")).toBe(true);
    for (const s of others(["in_review"])) expect(canSendBack(s)).toBe(false);
  });

  it("resubmit is legal ONLY from needs_revision", () => {
    expect(canResubmit("needs_revision")).toBe(true);
    for (const s of others(["needs_revision"])) expect(canResubmit(s)).toBe(false);
  });

  it("revise (demote-before-edit): draft stays draft; reviewed/approved demote to needs_revision; published is not editable", () => {
    expect(reviseTargetStatus("draft")).toBe("draft");
    expect(reviseTargetStatus("in_review")).toBe("needs_revision");
    expect(reviseTargetStatus("needs_revision")).toBe("needs_revision");
    expect(reviseTargetStatus("approved")).toBe("needs_revision");
    expect(reviseTargetStatus("published")).toBeNull();
  });
});

describe("humanization matrix (mirrors the DB CHECK exemptions)", () => {
  it("required for machine prose at the publishing default", () => {
    for (const t of ["blog", "faq", "caption", "pillar"] as const) {
      expect(humanizationRequired(t, "ai_draft_human_approve")).toBe(true);
      expect(humanizationRequired(t, "auto")).toBe(true);
    }
  });

  it("EXEMPT for schema_copy (any automation level)", () => {
    expect(humanizationRequired("schema_copy", "ai_draft_human_approve")).toBe(false);
    expect(humanizationRequired("schema_copy", "auto")).toBe(false);
    expect(humanizationRequired("schema_copy", "human_only")).toBe(false);
  });

  it("EXEMPT for human_only (any type)", () => {
    for (const t of ["blog", "faq", "caption", "pillar", "schema_copy"] as const) {
      expect(humanizationRequired(t, "human_only")).toBe(false);
    }
  });
});

describe("approval gate (mirrors the strengthened DB CHECK, returns the first blocker)", () => {
  const HASH = "abc123";
  const pass = (bodyHash = HASH) => ({ passed: true, body_hash: bodyHash });

  const base = {
    type: "blog" as const,
    automationLevel: "ai_draft_human_approve" as const,
    bodyHash: HASH,
    quality: pass(),
    compliance: pass(),
    humanization: { humanized: true, detection_score: 0.1, passes: true },
  };

  it("passes when everything holds", () => {
    expect(evaluateApprovalGate(base)).toEqual({ ok: true });
  });

  it("blocks: quality missing / not passed / stale", () => {
    expect(evaluateApprovalGate({ ...base, quality: null })).toEqual({
      ok: false,
      blocker: "quality_missing",
    });
    expect(
      evaluateApprovalGate({ ...base, quality: { passed: false, body_hash: HASH } })
    ).toEqual({ ok: false, blocker: "quality_not_passed" });
    expect(
      evaluateApprovalGate({ ...base, quality: pass("STALE") })
    ).toEqual({ ok: false, blocker: "quality_stale" });
  });

  it("blocks: compliance missing / not passed / stale", () => {
    expect(evaluateApprovalGate({ ...base, compliance: null })).toEqual({
      ok: false,
      blocker: "compliance_missing",
    });
    expect(
      evaluateApprovalGate({ ...base, compliance: { passed: false, body_hash: HASH } })
    ).toEqual({ ok: false, blocker: "compliance_not_passed" });
    expect(
      evaluateApprovalGate({ ...base, compliance: pass("STALE") })
    ).toEqual({ ok: false, blocker: "compliance_stale" });
  });

  it("blocks: humanization required for a blog but missing/failing", () => {
    expect(evaluateApprovalGate({ ...base, humanization: null })).toEqual({
      ok: false,
      blocker: "humanization_required",
    });
    expect(
      evaluateApprovalGate({
        ...base,
        humanization: { humanized: true, detection_score: 0.9, passes: false },
      })
    ).toEqual({ ok: false, blocker: "humanization_required" });
  });

  it("EXEMPTION: schema_copy with NO humanization still passes (verdicts + hash hold)", () => {
    expect(
      evaluateApprovalGate({ ...base, type: "schema_copy", humanization: null })
    ).toEqual({ ok: true });
  });

  it("EXEMPTION: human_only blog with NO humanization still passes", () => {
    expect(
      evaluateApprovalGate({
        ...base,
        automationLevel: "human_only",
        humanization: null,
      })
    ).toEqual({ ok: true });
  });

  it("a passed:'true' STRING (not boolean) does NOT count as passed", () => {
    expect(
      evaluateApprovalGate({
        ...base,
        quality: { passed: "true" as unknown as boolean, body_hash: HASH },
      })
    ).toEqual({ ok: false, blocker: "quality_not_passed" });
  });
});
