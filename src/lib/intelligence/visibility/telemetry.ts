import "server-only";

/**
 * M3 Visibility Tracker — redacted server-side telemetry, mirroring the plan
 * write path's rules (src/lib/plans/persist.ts, carried ticket d):
 *
 * Every failure/degradation line carries ONLY a stable greppable marker,
 * a stage or numeric counts, and a shape-checked error CODE — NO prompts,
 * NO payloads, NO tenant/client ids, NO error message text. A PostgREST
 * `message`/`details` can quote row data verbatim (which here would include
 * tracked prompt texts), and the secrets-in-logs rule is absolute
 * (docs/ops/environments.md §Secrets rules).
 */

import type { RunCoverage } from "./sampler";

/* ------------------------------------------------------------------ */
/* Write failures (persist.ts)                                         */
/* ------------------------------------------------------------------ */

export const VISIBILITY_WRITE_FAILURE_MARKER = "[visibility-write-failure]";

export type VisibilityWriteStage = "row_mapping" | "results_insert" | "thrown";

export function logVisibilityWriteFailure(
  stage: VisibilityWriteStage,
  cause: unknown
): void {
  console.error(
    `${VISIBILITY_WRITE_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`
  );
}

/**
 * Bare SQLSTATE/PostgREST code extraction ("23505", "PGRST301") — anything
 * that isn't a short alphanumeric token collapses to "unknown", so no data
 * can ride into the log line even through a hostile/misbehaving error object.
 * (Local mirror of the plans persist rule — that module is another owner's.)
 */
function errorCode(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) {
      return code;
    }
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Degraded runs (actions.ts)                                          */
/* ------------------------------------------------------------------ */

export const VISIBILITY_RUN_PARTIAL_MARKER = "[visibility-run-partial]";

/**
 * Exactly ONE line per degraded run (any failed samples, including a total
 * provider failure) — counts only, nothing redactable.
 */
export function logPartialRun(coverage: RunCoverage): void {
  const kinds = coverage.failuresByKind;
  console.error(
    `${VISIBILITY_RUN_PARTIAL_MARKER} requested=${coverage.requested} ` +
      `measured=${coverage.measured} rate_limited=${kinds.rate_limited} ` +
      `unavailable=${kinds.unavailable} invalid_response=${kinds.invalid_response} ` +
      `unknown=${kinds.unknown}`
  );
}
