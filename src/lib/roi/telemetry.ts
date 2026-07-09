import "server-only";

/**
 * M16 ROI / attribution — redacted server-side telemetry, mirroring the
 * visibility + audit write paths (intelligence/visibility/telemetry.ts,
 * intelligence/audit/persist.ts):
 *
 * Every failure/degradation line carries ONLY a stable greppable marker, a
 * stage or numeric counts, and a shape-checked error CODE — NO analytics
 * payloads, NO revenue/lead figures, NO period boundaries, NO tenant/client
 * ids, NO vendor names, NO error message text. A PostgREST `message`/`details`
 * (or a vendor error) can quote row data verbatim, and the secrets-in-logs rule
 * is absolute (docs/ops/environments.md §Secrets rules). ROI data is
 * commercially sensitive (a client's lead volume and revenue) — it never rides
 * a log line.
 */

export const ROI_WRITE_FAILURE_MARKER = "[roi-write-failure]";

export type RoiWriteStage = "captures_insert" | "thrown";

export function logRoiWriteFailure(stage: RoiWriteStage, cause: unknown): void {
  console.error(`${ROI_WRITE_FAILURE_MARKER} stage=${stage} code=${errorCode(cause)}`);
}

export const ROI_COLLECT_PARTIAL_MARKER = "[roi-collect-partial]";

/**
 * Exactly ONE line per degraded collection — counts only, nothing redactable.
 * `unhomed` counts sources that measured but have no schema home yet (the
 * flagged gap) so its rate is observable without naming which sources.
 */
export function logPartialCollection(counts: {
  requested: number;
  contributing: number;
  absent: number;
  failed: number;
  unhomed: number;
}): void {
  console.error(
    `${ROI_COLLECT_PARTIAL_MARKER} requested=${counts.requested} ` +
      `contributing=${counts.contributing} absent=${counts.absent} ` +
      `failed=${counts.failed} unhomed=${counts.unhomed}`,
  );
}

/**
 * Bare SQLSTATE/PostgREST code extraction ("23505", "PGRST301") — anything that
 * isn't a short alphanumeric token collapses to "unknown", so no data can ride
 * into the log line even through a hostile/misbehaving error object. (Local
 * mirror of the visibility/audit rule — those modules are other owners'.)
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
