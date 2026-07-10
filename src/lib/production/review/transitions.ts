/**
 * R3 content-lifecycle transition + approval-gate ENGINE (pure; no server/DB
 * imports; unit-tested in the default `npm test` run).
 *
 * The single source of truth for which review actions are legal from which
 * status, and for the approval-gate pre-check that MIRRORS the strengthened DB
 * CHECK (content_items_reviewed_before_approval + content_items_approver_present,
 * migration 0009). The DB CHECK is the real gate — this engine gives the actions
 * precise, honest refusals BEFORE the write, and is what the transition tests
 * pin (every legal + illegal transition).
 *
 * Governance: NOTHING here approves. `approve` is a legal transition only when
 * every gate condition already holds; the human caller supplies the approval,
 * the engine only says whether it is permitted.
 *
 * Lifecycle: draft → in_review → { needs_revision | approved } → published.
 *   - verdicts are recorded ONLY in in_review;
 *   - send-back: in_review → needs_revision;
 *   - resubmit:  needs_revision → in_review (a later body/title edit makes any
 *     prior verdict structurally stale via the body_hash binding);
 *   - approve:   in_review → approved (all gate conditions);
 *   - revise (demote-before-edit): a body/title mutation lands a reviewed/
 *     approved item in needs_revision; published is not editable here (publish
 *     stays behind change management — not wired in this batch).
 */

import type {
  AutomationLevel,
  ContentItemStatus,
  ContentItemType,
  ContentReviewVerdict,
  HumanizationResult,
} from "@/lib/types/db";

/* ------------------------------------------------------------------ */
/* Legal transitions (what each action requires / produces)            */
/* ------------------------------------------------------------------ */

/** A gate verdict may be recorded ONLY while the item is in review. */
export function canRecordVerdict(from: ContentItemStatus): boolean {
  return from === "in_review";
}

/** Approval is legal only from in_review (all gate conditions still apply). */
export function canApprove(from: ContentItemStatus): boolean {
  return from === "in_review";
}

/** Send-back (→ needs_revision) is legal only from in_review. */
export function canSendBack(from: ContentItemStatus): boolean {
  return from === "in_review";
}

/** Resubmit (→ in_review) is legal only from needs_revision. */
export function canResubmit(from: ContentItemStatus): boolean {
  return from === "needs_revision";
}

/**
 * The status a body/title edit lands the item in, or null if editing is illegal
 * at this seam. This is the "demote-before-edit" rule made usable: a draft edit
 * stays a draft; any edit to a reviewed/approved item lands it in needs_revision
 * (the body_hash change would otherwise violate the approval CHECK); a published
 * item is NOT editable here (re-publishing is a change-management concern, not
 * wired in this batch).
 */
export function reviseTargetStatus(
  from: ContentItemStatus
): ContentItemStatus | null {
  switch (from) {
    case "draft":
      return "draft";
    case "in_review":
    case "needs_revision":
    case "approved":
      return "needs_revision";
    case "published":
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Approval gate — mirrors the strengthened DB CHECK exactly.          */
/*                                                                     */
/* The DB gate (0009, post-Blocker-remediation) is FAIL-CLOSED via     */
/* jsonb containment: each verdict must be non-null AND contain        */
/* {passed: true (JSON boolean, type-exact), body_hash: <row hash>};   */
/* humanization (when required) must be non-null AND contain           */
/* {passes: true}. Absent keys, JSON nulls, string "true"/number 1 all */
/* fail — never NULL, never a cast error. The TS legs below mirror     */
/* that one-for-one: `=== null` ↔ the presence conjuncts; strict       */
/* `passed !== true` ↔ boolean-true containment (a string "true" is    */
/* rejected on both layers); strict `body_hash !== rowHash` ↔ hash     */
/* containment (undefined/null/mismatch all fail on both layers).      */
/* ------------------------------------------------------------------ */

/**
 * Humanization is required for machine-produced prose. Mirrors the DB CHECK's
 * exemption EXACTLY: exempt for schema_copy and for automation_level
 * 'human_only'; required for everything else (blog | faq | caption | pillar are
 * the only remaining types). Expressed as `type !== 'schema_copy'` so it stays
 * identical to the CHECK if the type enum is ever extended.
 */
export function humanizationRequired(
  type: ContentItemType,
  automationLevel: AutomationLevel
): boolean {
  return automationLevel !== "human_only" && type !== "schema_copy";
}

export interface ApprovalGateInput {
  type: ContentItemType;
  automationLevel: AutomationLevel;
  /** The row's current body_hash (verdicts must be bound to exactly this). */
  bodyHash: string;
  quality: ContentReviewVerdict | null;
  compliance: ContentReviewVerdict | null;
  humanization: HumanizationResult | null;
}

export type ApprovalBlocker =
  | "quality_missing"
  | "quality_not_passed"
  | "quality_stale"
  | "compliance_missing"
  | "compliance_not_passed"
  | "compliance_stale"
  | "humanization_required";

export type ApprovalGateResult =
  | { ok: true }
  | { ok: false; blocker: ApprovalBlocker };

/**
 * Evaluate the approval gate with the SAME acceptance set as the DB CHECK
 * (see the block comment above) — returns the FIRST blocker (so the action can
 * name it) or ok. The DB CHECK remains authoritative; this is the honest
 * pre-check + the tested contract. Both layers require the JSON boolean true
 * and an exactly-matching recorded hash; both reject absent keys, nulls, and
 * string/number truthiness.
 */
export function evaluateApprovalGate(
  input: ApprovalGateInput
): ApprovalGateResult {
  const { quality, compliance } = input;

  if (quality === null) return { ok: false, blocker: "quality_missing" };
  if (quality.passed !== true) return { ok: false, blocker: "quality_not_passed" };
  if (quality.body_hash !== input.bodyHash) {
    return { ok: false, blocker: "quality_stale" };
  }

  if (compliance === null) return { ok: false, blocker: "compliance_missing" };
  if (compliance.passed !== true) {
    return { ok: false, blocker: "compliance_not_passed" };
  }
  if (compliance.body_hash !== input.bodyHash) {
    return { ok: false, blocker: "compliance_stale" };
  }

  if (humanizationRequired(input.type, input.automationLevel)) {
    if (!input.humanization || input.humanization.passes !== true) {
      return { ok: false, blocker: "humanization_required" };
    }
  }

  return { ok: true };
}

// Referenced for documentation / test readability — the machine-prose types the
// CHECK requires humanization for (schema_copy is the sole exemption by type).
export const HUMANIZATION_REQUIRED_TYPES = [
  "blog",
  "faq",
  "caption",
  "pillar",
] as const;
