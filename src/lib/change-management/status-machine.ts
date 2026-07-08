/**
 * The site_changes status state machine (doc 04 §2; mirrors migration 0005's
 * CHECK constraints exactly).
 *
 * The database is the ultimate backstop. This module encodes a SUPERSET-SAFE
 * SUBSET of what the DB permits: every transition the layer will ever attempt is
 * (a) in {@link LEGAL_TRANSITIONS} and (b) produces a row that satisfies EVERY
 * site_changes CHECK ({@link assertRowSatisfiesConstraints}). So the layer can
 * never hand Postgres a row it would reject, and it can never take a shortcut
 * the DB would allow but the safety model forbids (e.g. previewed → reverted
 * without ever applying).
 *
 * DB constraints replicated here (0005):
 *  - method ∈ {wordpress, webflow, wix, edge_worker, pr}       (method_allowed)
 *  - change_type ∈ {h1, title, meta, schema, alt, content, canonical} (change_type_allowed)
 *  - automation_level ∈ {ai_draft_human_approve, human_only}   (no 'auto')
 *  - status ∈ {previewed, applied, reverted, auto_reverted}
 *  - diff is a JSON object (jsonb_typeof(diff) = 'object')      (diff_is_object)
 *  - status ≠ previewed  ⇒ applied_at NOT NULL       (applied_has_timestamp)
 *  - status ≠ previewed  ⇒ approved_by NOT NULL       (requires_approval)
 *  - status ∈ {reverted, auto_reverted} ⇒ reverted_at NOT NULL (reverted_has_timestamp)
 */

import {
  SITE_CHANGE_AUTOMATION_LEVELS,
  SITE_CHANGE_METHODS,
  SITE_CHANGE_STATUSES,
  SITE_CHANGE_TYPES,
  type SiteChangeRow,
  type SiteChangeStatus,
} from "@/lib/types/db";
import {
  ConstraintViolationError,
  IllegalTransitionError,
} from "./errors";

/**
 * Legal edges. Keys are the current status; values are the statuses the layer
 * may move to. `previewed → previewed` is the approval step (record approved_by
 * while still in preview — DB-legal because previewed rows are exempt from
 * requires_approval). Terminal states have no outgoing edges.
 */
export const LEGAL_TRANSITIONS: Readonly<
  Record<SiteChangeStatus, readonly SiteChangeStatus[]>
> = {
  previewed: ["previewed", "applied"],
  applied: ["reverted", "auto_reverted"],
  reverted: [],
  auto_reverted: [],
};

/** True when `to` is reachable from `from` under the safety model. */
export function isLegalTransition(
  from: SiteChangeStatus,
  to: SiteChangeStatus,
): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/** Throw unless `from → to` is a legal edge. */
export function assertLegalTransition(
  from: SiteChangeStatus,
  to: SiteChangeStatus,
): void {
  if (!isLegalTransition(from, to)) {
    throw new IllegalTransitionError(
      `illegal status transition ${from} → ${to} (legal from ${from}: ${
        LEGAL_TRANSITIONS[from].join(", ") || "none — terminal"
      })`,
    );
  }
}

/**
 * Assert a fully-composed row satisfies every site_changes CHECK constraint.
 * This is the same set Postgres enforces; the in-memory stub calls it so tests
 * exercise the DB backstop, and the manager calls it before persisting so an
 * illegal row is never even sent.
 */
export function assertRowSatisfiesConstraints(
  row: Pick<
    SiteChangeRow,
    | "method"
    | "change_type"
    | "diff"
    | "status"
    | "automation_level"
    | "approved_by"
    | "applied_at"
    | "reverted_at"
  >,
): void {
  if (!SITE_CHANGE_METHODS.includes(row.method)) {
    throw new ConstraintViolationError(
      `site_changes_method_allowed: '${row.method}' is not a valid write method`,
    );
  }
  if (!SITE_CHANGE_TYPES.includes(row.change_type)) {
    throw new ConstraintViolationError(
      `site_changes_change_type_allowed: '${row.change_type}' is not a valid change type`,
    );
  }
  // jsonb_typeof(diff) = 'object': a JSON object, never an array / primitive /
  // null. (The column is also NOT NULL; a SQL-null diff never reaches here.)
  const diff: unknown = row.diff;
  if (typeof diff !== "object" || diff === null || Array.isArray(diff)) {
    throw new ConstraintViolationError(
      `site_changes_diff_is_object: diff must be a JSON object (jsonb_typeof = 'object')`,
    );
  }
  if (!SITE_CHANGE_STATUSES.includes(row.status)) {
    throw new ConstraintViolationError(
      `site_changes_status_allowed: '${row.status}' is not a valid status`,
    );
  }
  if (!SITE_CHANGE_AUTOMATION_LEVELS.includes(row.automation_level)) {
    // 'auto' (or anything else) is structurally impossible on this table.
    throw new ConstraintViolationError(
      `site_changes_automation_level_allowed: '${row.automation_level}' is not permitted ` +
        `(autonomous on-page publishing is banned — doc 00 §2, doc 04 §6)`,
    );
  }
  if (row.status !== "previewed") {
    if (row.approved_by == null) {
      throw new ConstraintViolationError(
        `site_changes_requires_approval: status '${row.status}' requires approved_by`,
      );
    }
    if (row.applied_at == null) {
      throw new ConstraintViolationError(
        `site_changes_applied_has_timestamp: status '${row.status}' requires applied_at`,
      );
    }
  }
  if (
    (row.status === "reverted" || row.status === "auto_reverted") &&
    row.reverted_at == null
  ) {
    throw new ConstraintViolationError(
      `site_changes_reverted_has_timestamp: status '${row.status}' requires reverted_at`,
    );
  }
}
