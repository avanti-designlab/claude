import "server-only";

/**
 * M6 decay-scan — redacted server-side telemetry, mirroring the audit + plan
 * write paths (src/lib/intelligence/audit/persist.ts, src/lib/plans/persist.ts).
 *
 * Every failure line carries ONLY a stable greppable marker, the stage, and a
 * shape-checked error CODE — NO crawled content, NO URLs, NO tenant/client ids,
 * NO error-message text. A PostgREST `message`/`details` (or a thrown crawl
 * error) can quote row/page data verbatim, and the secrets-in-logs rule
 * (docs/ops/environments.md §Secrets rules) is absolute.
 */

export const DECAY_FAILURE_MARKER = "[decay-scan-failure]";

/** The decay scan does not persist (see the module README), so the only
 *  failure stage is an unexpected throw during crawl/assess. Typed as a union
 *  for house-consistency and future stages. */
export type DecayFailureStage = "thrown";

export function logDecayFailure(stage: DecayFailureStage, cause: unknown): void {
  console.error(`${DECAY_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

/**
 * Bare SQLSTATE/PostgREST code extraction ("23505", "PGRST301") — anything that
 * isn't a short alphanumeric token collapses to "unknown", so no data can ride
 * into the log line even through a hostile/misbehaving error object. Local
 * mirror of the audit/plan persist rule (those modules are other owners').
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
