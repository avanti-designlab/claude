import "server-only";

/**
 * M18 Resource Center — redacted server-side telemetry (house contract; mirrors
 * src/lib/intelligence/monitoring/telemetry.ts + production/content/persist.ts).
 *
 * Every failure line carries ONLY a stable greppable marker, which stage failed,
 * and a shape-checked Postgres/PostgREST/error CODE — NO question or answer text,
 * NO retrieved source URLs, NO tenant/client ids, NO error message text, and
 * NEVER the raw vendor payload (which can quote the prompt). The
 * secrets-and-content-in-logs rule (docs/ops/environments.md §Secrets rules) is
 * absolute: a question is user content and must never ride into a log line.
 */

export const RESOURCE_CENTER_FAILURE_MARKER = "[resource-center-failure]";

export type ResourceFailureStage = "lookup" | "answer" | "web_search" | "thrown";

export function logResourceFailure(stage: ResourceFailureStage, cause: unknown): void {
  console.error(`${RESOURCE_CENTER_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/**
 * Bare SQLSTATE/PostgREST/error code extraction ("23505", "PGRST301") — anything
 * that isn't a short alphanumeric token collapses to "unknown", so no data can
 * ride into the log line even through a hostile/misbehaving error object.
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
