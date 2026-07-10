"use server";

/**
 * Enqueue a background scan run (ARCHITECTURE RULING; enqueue = instant
 * tenant-scoped insert of a `queued` row, then a non-blocking kick).
 *
 * SECURITY posture mirrors the M2 audit action:
 *  - TENANT IS CLAIM-SOURCED: tenant_id comes from the caller's VERIFIED JWT
 *    claim, never the browser; RLS (runs_insert: tenant_id = app.tenant_id() AND
 *    app.is_writer()) re-pins it regardless, and the composite FKs make a
 *    cross-client/cross-tenant property reference structurally impossible.
 *  - WRITER FLOOR: requireOperator() mirrors runs_insert's is_writer() honestly.
 *  - A5 REFUSE-AT-ENQUEUE (no queued-forever / doomed rows): visibility is
 *    vendor-gated (CitationDataProvider unwired) → refused; other vendor-free
 *    kinds are not yet executable in the queue → refused honestly; a property
 *    that is missing / not a crawlable website is refused BEFORE any row exists.
 *
 * SCOPE (this block): `audit` is the fully-wired executable kind (its background
 * execution adapter + `audits` persistence exist). monitor/decay/local/entity
 * share the same crawl core but their background-run persistence/result_ref
 * contracts are a scoped follow-up with their engine owners (decay has no
 * persisted-artifact home in the frozen schema today), so they are refused here
 * rather than queued to compute-and-discard. visibility is vendor-gated (A5).
 */

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { hostIsBlockedLiteral } from "@/lib/intelligence/crawl";
import { createClient } from "@/lib/supabase/server";
import type { RunKind } from "@/lib/types/db";
import { kickProcessor } from "./kick";

/** FROZEN CONTRACT — the run-trigger UI consumes this exact shape. */
export type EnqueueRunResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "not_crawlable"
        | "unsupported_kind"
        | "vendor_unavailable"
        | "enqueue_failed";
      error: string;
    };

/** Kinds the processor can actually execute today (see header SCOPE note). */
const EXECUTABLE_KINDS: readonly RunKind[] = ["audit"];

const FORBIDDEN_ERROR =
  "You don’t have permission to start scans — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const NOT_FOUND_ERROR =
  "We couldn’t find that property. It may have been removed — refresh the client’s properties and try again.";
const NOT_CRAWLABLE_ERROR =
  "This property can’t be scanned — scans need a website property with a working http(s) address.";
const VENDOR_UNAVAILABLE_ERROR =
  "Visibility tracking isn’t connected yet, so there’s nothing to scan for it. It activates once the citation-data provider is wired.";
const UNSUPPORTED_KIND_ERROR =
  "This scan type isn’t available in the background queue yet. Audits can be scheduled today; the rest activate as they’re wired.";
const ENQUEUE_FAILED_ERROR =
  "We couldn’t queue this scan. Check your connection and try again.";

interface PropertyRow {
  id: string;
  client_id: string;
  type: string;
  url: string;
}

function isCrawlableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return !hostIsBlockedLiteral(parsed.hostname);
}

/** Best-effort attribution: the enqueuing operator's tenant_users.id (the
 *  runs.requested_by FK target). NULL when unresolved — legal (system/sweeper
 *  re-queues are NULL too), never fabricated. RLS scopes this read to the tenant. */
async function resolveRequestedBy(
  supabase: Awaited<ReturnType<typeof createClient>>,
  authUserId: string | undefined
): Promise<string | null> {
  if (!authUserId) return null;
  const res = await supabase
    .from("tenant_users")
    .select("id")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (res.error || !res.data) return null;
  return (res.data as { id: string }).id;
}

export async function enqueueRun(input: {
  kind: RunKind;
  /** Required for property-scoped kinds (audit). */
  propertyId?: string;
}): Promise<EnqueueRunResult> {
  // AUTHZ — writer floor. requireOperator authenticates first (its /login
  // redirect must propagate; only the wrong-role case is trapped).
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  const kind = input?.kind;
  // A5: vendor-gated + not-yet-executable kinds refuse HERE — no queued row.
  if (kind === "visibility") {
    return { ok: false, reason: "vendor_unavailable", error: VENDOR_UNAVAILABLE_ERROR };
  }
  if (!EXECUTABLE_KINDS.includes(kind)) {
    return { ok: false, reason: "unsupported_kind", error: UNSUPPORTED_KIND_ERROR };
  }

  // audit is property-scoped. Clamp the one caller-supplied field.
  const propertyId = typeof input?.propertyId === "string" ? input.propertyId.trim() : "";
  if (!isUuidV4(propertyId)) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }

  const supabase = await createClient();
  const propertyRes = await supabase
    .from("properties")
    .select("id, client_id, type, url")
    .eq("id", propertyId)
    .maybeSingle();
  if (propertyRes.error) {
    return { ok: false, reason: "enqueue_failed", error: ENQUEUE_FAILED_ERROR };
  }
  if (!propertyRes.data) {
    // RLS-empty read: a nonexistent id and another tenant's id are the SAME
    // observation here — correct and intended (doc 03 §4).
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }
  const property = propertyRes.data as PropertyRow;
  if (property.type !== "website" || !isCrawlableUrl(property.url)) {
    return { ok: false, reason: "not_crawlable", error: NOT_CRAWLABLE_ERROR };
  }

  const requestedBy = await resolveRequestedBy(supabase, claims.sub);

  const insertRes = await supabase
    .from("runs")
    .insert({
      tenant_id: claims.tenantId,
      client_id: property.client_id,
      property_id: property.id,
      kind: "audit",
      status: "queued",
      requested_by: requestedBy,
    })
    .select("id")
    .single();
  if (insertRes.error || !insertRes.data) {
    return { ok: false, reason: "enqueue_failed", error: ENQUEUE_FAILED_ERROR };
  }
  const runId = (insertRes.data as { id: string }).id;

  // A9: non-blocking kick — failure must NOT fail the enqueue (sweeper backstop).
  kickProcessor("process");

  return { ok: true, runId };
}
