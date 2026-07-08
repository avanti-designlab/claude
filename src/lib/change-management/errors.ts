/**
 * Typed errors for the unified change-management layer (doc 04 §2).
 *
 * Every failure mode that protects the "no write bypasses this layer" guarantee
 * is a distinct, named error so callers, the QA rollback suite, and Code Review
 * can assert on the exact seam that refused. All extend {@link ChangeManagementError}
 * so a caller can catch the whole family.
 *
 * Errors NEVER carry credentials or raw site content beyond what is needed to
 * identify the change (doc 04 §5: creds are never logged / returned). Drift
 * between a preview and apply is NON-fatal here — it is surfaced as a
 * `PipelineWarning` ('drift_detected'), because the fresh before-state is
 * re-captured at apply time and remains the authoritative rollback baseline.
 */

/** Stable machine-readable codes for every guard in this layer. */
export type ChangeErrorCode =
  | "authorization"
  | "automation_level"
  | "approval_required"
  | "illegal_transition"
  | "constraint_violation"
  | "tenant_scope"
  | "not_found"
  | "method_not_registered"
  | "rollback_reason_required";

export class ChangeManagementError extends Error {
  readonly code: ChangeErrorCode;
  constructor(message: string, code: ChangeErrorCode) {
    super(message);
    this.name = "ChangeManagementError";
    this.code = code;
  }
}

/** Acting user's role may not write (doc 04 §5: client_viewer never writes). */
export class AuthorizationError extends ChangeManagementError {
  constructor(message: string) {
    super(message, "authorization");
    this.name = "AuthorizationError";
  }
}

/**
 * A site write carried automation_level 'auto' (or an unknown level) — a fully
 * autonomous on-page publish, banned at the seam (doc 00 §2, CLAUDE.md rule 5,
 * doc 04 §6). Upstream `src/lib/plan/audit-merge.ts` CLAMPS 'auto' on publishing
 * modules; this layer is the last line and REJECTS rather than clamps.
 */
export class AutomationLevelError extends ChangeManagementError {
  constructor(message: string) {
    super(message, "automation_level");
    this.name = "AutomationLevelError";
  }
}

/** Apply attempted on a change with no recorded human approver. */
export class ApprovalRequiredError extends ChangeManagementError {
  constructor(message: string) {
    super(message, "approval_required");
    this.name = "ApprovalRequiredError";
  }
}

/** A status transition not permitted by the state machine (doc 03 §3 CHECKs). */
export class IllegalTransitionError extends ChangeManagementError {
  constructor(message: string) {
    super(message, "illegal_transition");
    this.name = "IllegalTransitionError";
  }
}

/** A resulting row would violate a site_changes CHECK constraint (DB backstop). */
export class ConstraintViolationError extends ChangeManagementError {
  constructor(message: string) {
    super(message, "constraint_violation");
    this.name = "ConstraintViolationError";
  }
}

/** Operation mixed tenant/client context — the layer never crosses tenants. */
export class TenantScopeError extends ChangeManagementError {
  constructor(message: string) {
    super(message, "tenant_scope");
    this.name = "TenantScopeError";
  }
}

/** No change with that id is visible in the caller's tenant scope. */
export class ChangeNotFoundError extends ChangeManagementError {
  constructor(message: string) {
    super(message, "not_found");
    this.name = "ChangeNotFoundError";
  }
}

/** No WriteMethod adapter registered for a change's method — cannot apply OR rollback. */
export class MethodNotRegisteredError extends ChangeManagementError {
  constructor(message: string) {
    super(message, "method_not_registered");
    this.name = "MethodNotRegisteredError";
  }
}

/**
 * A manual rollback arrived without a reason. `reverted_reason` is how the
 * audit trail explains itself (doc 04 §2 step 5) — this layer requires it for
 * BOTH manual and auto rollback (auto generates its own from the breaches),
 * even though the column is nullable in the schema.
 */
export class RollbackReasonRequiredError extends ChangeManagementError {
  constructor(message: string) {
    super(message, "rollback_reason_required");
    this.name = "RollbackReasonRequiredError";
  }
}
