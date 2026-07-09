import "server-only";

/**
 * M17 — the AlertSink the change-management ChangeManager writes through
 * (src/lib/change-management/types.ts: "M17 supplies the real sink at 1.8").
 *
 * ── UNIFY, DON'T RE-FIRE ─────────────────────────────────────────────────────
 * The `auto_rollback_fired` alert is FIRED by the ChangeManager when auto-
 * rollback executes (manager.ts emitAutoRollbackAlert). M17 does NOT detect
 * auto-rollbacks and does NOT own a rule for them — it supplies THIS sink so the
 * event the manager already fired lands in the SAME `alerts` table, through the
 * SAME dedup+persist core (persist.ts) as every other alert. One event → one
 * write path. There is no second detection and no double-write.
 *
 * Dedup is keyed to the reverted change (rows.ts autoRollbackFingerprint), so a
 * re-emit for the same rollback is idempotent while a rollback of a DIFFERENT
 * change alerts distinctly.
 *
 * ── SECURITY ─────────────────────────────────────────────────────────────────
 * The sink is constructed at wiring time with a CLAIM-SOURCED tenantId and a
 * claim-scoped Supabase client. It pins the row's tenant_id to THAT tenant and
 * never reads the draft's tenantId — RLS (`alerts_insert`) + the composite FK
 * (tenant, client) → clients re-pin below us, so a draft whose clientId is not
 * in the tenant is refused by the FK, never mis-attributed.
 *
 * ── FAILURE ──────────────────────────────────────────────────────────────────
 * The ChangeManager wraps emit() in try/catch and records a PipelineWarning on
 * throw. So on a persist failure this sink logs ONE redacted telemetry line and
 * throws a SANITIZED marker error (no DB text) — the manager's warning is then
 * truthful ("the alert didn't land") but leak-free. A dedup (already-open) or
 * success resolves quietly.
 */

import type { AlertDraft, AlertSink } from "@/lib/change-management";
import type { Json } from "@/lib/types/db";
import { autoRollbackPayload } from "./rules";
import type { AlertInsertRow } from "./rows";
import { persistAlertRowsCore, type Supabase } from "./persist";

/** Thrown to the ChangeManager on a persist failure — carries NO DB detail. */
export class AlertPersistError extends Error {
  constructor() {
    super("alert persistence failed");
    this.name = "AlertPersistError";
  }
}

function readString(payload: Json, key: string): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const value = (payload as Record<string, Json>)[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Map a change-management AlertDraft into the `alerts` insert row. tenant_id is
 * pinned to the sink's CLAIM tenant (never the draft's). Severity is clamped to
 * the frozen CHECK set defensively (the manager sends "critical").
 */
export function autoRollbackRowFromDraft(tenantId: string, draft: AlertDraft): AlertInsertRow {
  const changeId = readString(draft.payload, "changeId") ?? "unknown";
  const revertedReason = readString(draft.payload, "revertedReason");
  const detectedAt = readString(draft.payload, "at") ?? "";
  const severity = draft.severity === "warning" ? "warning" : "critical";
  return {
    tenant_id: tenantId,
    client_id: draft.clientId,
    type: "auto_rollback_fired",
    severity,
    payload: autoRollbackPayload({
      changeId,
      summary: revertedReason ?? "Auto-rollback fired on a correlated visibility/traffic drop",
      detectedAt,
    }),
  };
}

/**
 * Build the M17 AlertSink for a claim-scoped request. Inject into the
 * ChangeManager (ChangeManagerDeps.alertSink) at the change-management wiring
 * seam. tenantId MUST be claim-sourced by the caller.
 */
export function createAlertingSink(supabase: Supabase, tenantId: string): AlertSink {
  return {
    async emit(draft: AlertDraft): Promise<void> {
      const row = autoRollbackRowFromDraft(tenantId, draft);
      const outcome = await persistAlertRowsCore(supabase, draft.clientId, [row]);
      if (outcome.kind === "failed") {
        // Redacted line already logged inside the core; surface a sanitized
        // throw so the manager records a leak-free warning.
        throw new AlertPersistError();
      }
      // "inserted" | "deduped" | "no_alerts" → the event is unified; resolve quietly.
    },
  };
}
