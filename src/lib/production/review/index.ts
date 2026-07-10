/**
 * R3 content review-lifecycle module (doc 03 §6; migration 0009). The HUMAN
 * approval seam — AI drafts, humans approve.
 *
 * Public surface = the pure transition/gate ENGINE + its types. The "use server"
 * actions (recordQualityVerdict / recordComplianceVerdict / approveContentItem /
 * sendBackContentItem / resubmitContentItem / reviseContentDraft) are imported
 * DIRECTLY from "./actions" by their callers — this index deliberately does NOT
 * re-export them (the same convention the brand-kit + content modules follow: an
 * index must not turn actions into a second import path, and re-exporting a
 * server action through a non-"use server" barrel is unsound).
 */

export {
  canApprove,
  canRecordVerdict,
  canResubmit,
  canSendBack,
  evaluateApprovalGate,
  humanizationRequired,
  reviseTargetStatus,
  HUMANIZATION_REQUIRED_TYPES,
  type ApprovalBlocker,
  type ApprovalGateInput,
  type ApprovalGateResult,
} from "./transitions";
