import "server-only";

/**
 * M5 — redacted server-side telemetry (house contract; mirrors
 * src/lib/intelligence/audit/persist.ts and visibility/telemetry.ts).
 *
 * Every failure line carries ONLY a stable greppable marker, which stage
 * failed, and a shape-checked Postgres/PostgREST error CODE — NO payloads, NO
 * crawled content or URLs, NO tenant/client/property ids, NO error message
 * text. A PostgREST `message`/`details` can quote row data verbatim, and the
 * secrets-in-logs rule (docs/ops/environments.md §Secrets rules) is absolute.
 */

export const MONITORING_WRITE_FAILURE_MARKER = "[monitoring-write-failure]";
export const MONITORING_RUN_FAILURE_MARKER = "[monitoring-run-failure]";

export type MonitorWriteStage = "dedup_read" | "alerts_insert" | "thrown";

export function logMonitorWriteFailure(stage: MonitorWriteStage, cause: unknown): void {
  console.error(`${MONITORING_WRITE_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

export function logMonitorRunFailure(cause: unknown): void {
  console.error(`${MONITORING_RUN_FAILURE_MARKER} stage=thrown code=${errorCode(cause)}`);
}

/**
 * Bare SQLSTATE/PostgREST code extraction ("23505", "PGRST301") — anything
 * that isn't a short alphanumeric token collapses to "unknown", so no data can
 * ride into the log line even through a hostile/misbehaving error object.
 * (Local mirror of the plans/audit/visibility rule — those modules are other
 * owners'.)
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
