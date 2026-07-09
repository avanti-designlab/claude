import "server-only";

/**
 * M4 Competitor reverse-engineering — redacted server-side telemetry, mirroring
 * the audit/visibility write paths (audit/persist.ts, visibility/telemetry.ts):
 *
 * Every failure line carries ONLY a stable greppable marker, a stage, and a
 * shape-checked error CODE — NO competitor URLs, NO crawled content, NO tenant/
 * client ids, NO error message text. A PostgREST `message`/`details` can quote
 * row data verbatim, and crawled competitor pages / cited URLs are exactly the
 * kind of payload the secrets-in-logs rule keeps out of hosted logs
 * (docs/ops/environments.md §Secrets rules).
 */

export const COMPETITOR_FAILURE_MARKER = "[competitor-analysis-failure]";

export type CompetitorFailureStage = "client_audit" | "competitor_crawl" | "read" | "thrown";

export function logCompetitorFailure(stage: CompetitorFailureStage, cause: unknown): void {
  console.error(`${COMPETITOR_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/**
 * Bare SQLSTATE/PostgREST code extraction ("23505", "PGRST301") — anything that
 * isn't a short alphanumeric token collapses to "unknown", so no data can ride
 * into the log line even through a hostile/misbehaving error object. (Local
 * mirror of the audit/plans persist rule — those modules are other owners'.)
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
