"use server";

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { createClient } from "@/lib/supabase/server";
import type {
  ContentItemStatus,
  ContentReviewVerdict,
  Json,
} from "@/lib/types/db";
import {
  applyContentPatch,
  readReviewRow,
  resolveMemberId,
  type ReviewRow,
  type Supabase,
} from "./persist";
import {
  canApprove,
  canRecordVerdict,
  canResubmit,
  canSendBack,
  evaluateApprovalGate,
  reviseTargetStatus,
  type ApprovalBlocker,
} from "./transitions";

/**
 * R3 content review-lifecycle server actions (doc 03 §6; CLAUDE.md rule 5). This
 * is the HUMAN approval seam: AI drafts, humans approve.
 *
 * Security posture mirrors the M8 content actions:
 *  - TENANT SCOPING IS CLAIM-SOURCED. The browser sends only a contentItemId (+
 *    a verdict / reason / edit); the tenant comes from the verified JWT claim,
 *    and RLS (`content_items_update`, migration 0005 — the is_writer floor)
 *    re-pins every write. The guard is `requireOperator()` (agency_admin |
 *    operator), mirroring that floor honestly.
 *  - APPROVER / REVIEWER IDENTITY IS RESOLVED FROM VERIFIED CLAIMS, NEVER
 *    CALLER-SUPPLIED. approved_by / reviewed_by come from the caller's
 *    tenant_users.id (resolved off the verified `sub`), so no caller can name a
 *    different human. The strengthened DB CHECKs (0009) are the real gate.
 *  - NOTHING AUTO-APPROVES, NOTHING SYNTHESIZES A VERDICT. `passed` is the
 *    gate's own decision passed in; approve only transitions when every
 *    condition already holds; the verdict-record actions persist a gate's
 *    verdict — they never invent one.
 *
 * Publish (approved → published) is NOT wired here: publishing stays behind
 * change management (rule 4), and no publish wiring is authorized in this batch.
 */

/* ------------------------------------------------------------------ */
/* Result contract                                                     */
/* ------------------------------------------------------------------ */

export type ReviewFailureReason =
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "illegal_transition"
  | "not_ready"
  | "no_membership"
  | "write_failed";

export type ReviewActionResult =
  | { ok: true; status: ContentItemStatus }
  | { ok: false; reason: ReviewFailureReason; error: string };

/* Interface-voice outcomes (doc 06 §6). */
const FORBIDDEN_ERROR =
  "You don’t have permission to review content — that’s an agency staff action. Ask your admin, or to change your role.";
const NOT_FOUND_ERROR =
  "We couldn’t find that draft. It may have been removed — refresh and try again.";
const READ_FAILED_ERROR =
  "We couldn’t load that draft. Check your connection and try again.";
const WRITE_FAILED_ERROR =
  "We couldn’t save this change. Check your connection and try again.";
const NO_MEMBERSHIP_ERROR =
  "We couldn’t confirm your account on this workspace, so we didn’t record this. Sign out and back in, then try again.";
const NOT_IN_REVIEW_ERROR =
  "This draft isn’t in review, so that step doesn’t apply. Refresh to see its current state.";
const NOT_NEEDS_REVISION_ERROR =
  "This draft isn’t awaiting revision, so it can’t be resubmitted. Refresh to see its current state.";
const PUBLISHED_NOT_EDITABLE_ERROR =
  "Published content can’t be edited here. Create a new draft to make changes.";
const VERDICT_INPUT_ERROR =
  "We couldn’t record this review. A pass/fail decision is required.";
const REASON_REQUIRED_ERROR =
  "Add a short reason so the writer knows what to revise before sending it back.";
const NOTHING_TO_REVISE_ERROR =
  "Add new content or a new title before saving the revision.";

const REASON_MAX = 2000;
const NOTE_MAX = 2000;
const TITLE_MAX = 200;
/** A generous body cap at the seam (the column itself is uncapped) — bounds the
 *  write without truncating legitimate long-form content. Flagged for review. */
const BODY_MAX = 200_000;

/** Precise, honest message for each approval-gate blocker. */
function approvalBlockerMessage(blocker: ApprovalBlocker): string {
  switch (blocker) {
    case "quality_missing":
      return "The content-quality review hasn’t been recorded yet.";
    case "quality_not_passed":
      return "The content-quality review hasn’t passed yet.";
    case "quality_stale":
      return "The content changed since the content-quality review — it needs re-reviewing before approval.";
    case "compliance_missing":
      return "The compliance review hasn’t been recorded yet.";
    case "compliance_not_passed":
      return "The compliance review hasn’t passed yet.";
    case "compliance_stale":
      return "The content changed since the compliance review — it needs re-reviewing before approval.";
    case "humanization_required":
      return "This content needs to pass the humanization check before it can be approved.";
  }
}

/* ------------------------------------------------------------------ */
/* Shared load: authorize (is_writer floor) + read the row            */
/* ------------------------------------------------------------------ */

type Loaded =
  | { ok: true; claims: { tenantId: string; sub: string }; supabase: Supabase; row: ReviewRow }
  | { ok: false; result: ReviewActionResult };

async function loadForReview(contentItemId: unknown): Promise<Loaded> {
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, result: { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR } };
    }
    throw err;
  }

  const id = typeof contentItemId === "string" ? contentItemId.trim() : "";
  if (!isUuidV4(id)) {
    return { ok: false, result: { ok: false, reason: "not_found", error: NOT_FOUND_ERROR } };
  }

  const supabase = await createClient();
  const read = await readReviewRow(supabase, id);
  if (!read.ok) {
    return { ok: false, result: { ok: false, reason: "write_failed", error: READ_FAILED_ERROR } };
  }
  if (!read.row) {
    return { ok: false, result: { ok: false, reason: "not_found", error: NOT_FOUND_ERROR } };
  }
  return {
    ok: true,
    claims: { tenantId: claims.tenantId, sub: claims.sub },
    supabase,
    row: read.row,
  };
}

function clampText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/* ------------------------------------------------------------------ */
/* Verdict recording (records a gate's decision — never synthesizes)   */
/* ------------------------------------------------------------------ */

export interface RecordVerdictInput {
  contentItemId: string;
  /** The GATE's decision — passed in, never computed here. */
  passed: boolean;
  /** Optional reviewer note (reviewer-authored; stored, never logged). */
  note?: string;
}

async function recordVerdict(
  gate: "quality" | "compliance",
  input: RecordVerdictInput
): Promise<ReviewActionResult> {
  const loaded = await loadForReview(input?.contentItemId);
  if (!loaded.ok) return loaded.result;
  const { claims, supabase, row } = loaded;

  if (typeof input?.passed !== "boolean") {
    return { ok: false, reason: "invalid_input", error: VERDICT_INPUT_ERROR };
  }
  if (!canRecordVerdict(row.status)) {
    return { ok: false, reason: "illegal_transition", error: NOT_IN_REVIEW_ERROR };
  }

  const memberId = await resolveMemberId(supabase, claims.sub);
  if (!memberId) {
    return { ok: false, reason: "no_membership", error: NO_MEMBERSHIP_ERROR };
  }

  const note = clampText(input.note, NOTE_MAX);
  const verdict: ContentReviewVerdict = {
    passed: input.passed,
    // Bind the verdict to EXACTLY the content version reviewed (0009): the
    // row's STORED body_hash, copied as read. BINDING CONDITION of the sha256
    // ratification (Orchestrator, 2026-07-10): the 0009 trigger is the SOLE
    // hash producer — application code NEVER recomputes this hash. If the row
    // is edited between this read and the write, the trigger re-hashes and the
    // fail-closed CHECK makes this (now-stale) verdict unable to approve.
    body_hash: row.body_hash,
    reviewed_by: memberId,
    reviewed_at: new Date().toISOString(),
    ...(note ? { note } : {}),
  };

  const column = gate === "quality" ? "quality_review" : "compliance_review";
  const res = await applyContentPatch(
    supabase,
    claims.tenantId,
    row.id,
    { [column]: verdict as unknown as Json },
    "verdict_write"
  );
  return res.ok
    ? { ok: true, status: res.status }
    : { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
}

export async function recordQualityVerdict(
  input: RecordVerdictInput
): Promise<ReviewActionResult> {
  return recordVerdict("quality", input);
}

export async function recordComplianceVerdict(
  input: RecordVerdictInput
): Promise<ReviewActionResult> {
  return recordVerdict("compliance", input);
}

/* ------------------------------------------------------------------ */
/* Approve (in_review → approved) — the human approval act             */
/* ------------------------------------------------------------------ */

export async function approveContentItem(input: {
  contentItemId: string;
}): Promise<ReviewActionResult> {
  const loaded = await loadForReview(input?.contentItemId);
  if (!loaded.ok) return loaded.result;
  const { claims, supabase, row } = loaded;

  if (!canApprove(row.status)) {
    return { ok: false, reason: "illegal_transition", error: NOT_IN_REVIEW_ERROR };
  }

  // Pre-check the strengthened gate for a precise message; the DB CHECK is the
  // authoritative backstop (and catches any read↔write race).
  const gate = evaluateApprovalGate({
    type: row.type,
    automationLevel: row.automation_level,
    bodyHash: row.body_hash,
    quality: row.quality_review,
    compliance: row.compliance_review,
    humanization: row.humanization,
  });
  if (!gate.ok) {
    return { ok: false, reason: "not_ready", error: approvalBlockerMessage(gate.blocker) };
  }

  // The named human approver — resolved from VERIFIED claims, never supplied.
  const memberId = await resolveMemberId(supabase, claims.sub);
  if (!memberId) {
    return { ok: false, reason: "no_membership", error: NO_MEMBERSHIP_ERROR };
  }

  const res = await applyContentPatch(
    supabase,
    claims.tenantId,
    row.id,
    {
      status: "approved",
      approved_by: memberId,
      approved_at: new Date().toISOString(),
    },
    "approve_write"
  );
  return res.ok
    ? { ok: true, status: res.status }
    : { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
}

/* ------------------------------------------------------------------ */
/* Send-back (in_review → needs_revision) with a recorded reason       */
/* ------------------------------------------------------------------ */

export interface SendBackInput {
  contentItemId: string;
  /** Which gate is returning the draft (attributes the reason). */
  gate: "quality" | "compliance";
  /** Required — recorded as the failing gate verdict's note. */
  reason: string;
}

export async function sendBackContentItem(
  input: SendBackInput
): Promise<ReviewActionResult> {
  const loaded = await loadForReview(input?.contentItemId);
  if (!loaded.ok) return loaded.result;
  const { claims, supabase, row } = loaded;

  if (input?.gate !== "quality" && input?.gate !== "compliance") {
    return { ok: false, reason: "invalid_input", error: VERDICT_INPUT_ERROR };
  }
  if (!canSendBack(row.status)) {
    return { ok: false, reason: "illegal_transition", error: NOT_IN_REVIEW_ERROR };
  }
  const reason = clampText(input.reason, REASON_MAX);
  if (reason === "") {
    return { ok: false, reason: "invalid_input", error: REASON_REQUIRED_ERROR };
  }

  const memberId = await resolveMemberId(supabase, claims.sub);
  if (!memberId) {
    return { ok: false, reason: "no_membership", error: NO_MEMBERSHIP_ERROR };
  }

  // The reason is recorded as the failing gate's verdict note — RATIFIED
  // (Orchestrator, 2026-07-10): no dedicated send-back-reason column; the
  // send-back IS a real failing verdict (bound to the reviewed hash) plus the
  // demotion to needs_revision, in one write.
  const verdict: ContentReviewVerdict = {
    passed: false,
    // Stored hash copied as read — never recomputed (trigger-sole-producer
    // binding condition; see recordVerdict).
    body_hash: row.body_hash,
    reviewed_by: memberId,
    reviewed_at: new Date().toISOString(),
    note: reason,
  };
  const column = input.gate === "quality" ? "quality_review" : "compliance_review";
  const res = await applyContentPatch(
    supabase,
    claims.tenantId,
    row.id,
    { [column]: verdict as unknown as Json, status: "needs_revision" },
    "send_back_write"
  );
  return res.ok
    ? { ok: true, status: res.status }
    : { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
}

/* ------------------------------------------------------------------ */
/* Resubmit (needs_revision → in_review)                               */
/* ------------------------------------------------------------------ */

export async function resubmitContentItem(input: {
  contentItemId: string;
}): Promise<ReviewActionResult> {
  const loaded = await loadForReview(input?.contentItemId);
  if (!loaded.ok) return loaded.result;
  const { claims, supabase, row } = loaded;

  if (!canResubmit(row.status)) {
    return { ok: false, reason: "illegal_transition", error: NOT_NEEDS_REVISION_ERROR };
  }

  // Prior verdicts are left in place: any body/title edit already changed the
  // body_hash, so they are structurally stale and cannot re-approve until fresh
  // verdicts (bound to the new hash) are recorded.
  const res = await applyContentPatch(
    supabase,
    claims.tenantId,
    row.id,
    { status: "in_review" },
    "resubmit_write"
  );
  return res.ok
    ? { ok: true, status: res.status }
    : { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
}

/* ------------------------------------------------------------------ */
/* Revise (demote-before-edit) — the legal body/title edit path        */
/* ------------------------------------------------------------------ */

export interface ReviseInput {
  contentItemId: string;
  /** New body (non-empty when provided). */
  body?: string;
  /** New title; explicit null clears it to "Untitled". */
  title?: string | null;
}

export async function reviseContentDraft(
  input: ReviseInput
): Promise<ReviewActionResult> {
  const loaded = await loadForReview(input?.contentItemId);
  if (!loaded.ok) return loaded.result;
  const { claims, supabase, row } = loaded;

  const target = reviseTargetStatus(row.status);
  if (target === null) {
    return { ok: false, reason: "illegal_transition", error: PUBLISHED_NOT_EDITABLE_ERROR };
  }

  const patch: Record<string, Json | null> = {};

  if (input?.body !== undefined) {
    const body = clampText(input.body, BODY_MAX);
    if (body === "") {
      return { ok: false, reason: "invalid_input", error: NOTHING_TO_REVISE_ERROR };
    }
    patch.body = body;
  }
  if (input?.title !== undefined) {
    // null clears the title; a string is trimmed + capped.
    patch.title = input.title === null ? null : clampText(input.title, TITLE_MAX) || null;
  }
  if (patch.body === undefined && patch.title === undefined) {
    return { ok: false, reason: "invalid_input", error: NOTHING_TO_REVISE_ERROR };
  }

  // Demote-before-edit made usable: the target status keeps the row out of the
  // approval gate while the body_hash trigger recomputes the hash (invalidating
  // any prior verdicts). The DB CHECK makes the illegal "edit while approved"
  // path structurally impossible; this makes the legal path usable.
  patch.status = target;

  const res = await applyContentPatch(
    supabase,
    claims.tenantId,
    row.id,
    patch,
    "revise_write"
  );
  if (!res.ok) {
    return { ok: false, reason: "write_failed", error: WRITE_FAILED_ERROR };
  }
  return { ok: true, status: res.status };
}
