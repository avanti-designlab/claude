"use server";

import { AuthorizationError, requireAuth, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { hostIsBlockedLiteral } from "@/lib/intelligence/crawl";
import { createClient } from "@/lib/supabase/server";
import { monitorProperty } from "./monitor";
import { liveFetchPort, liveResolvePort } from "./live-fetch";
import { persistMonitorAlerts, type PersistMonitorOutcome } from "./persist";
import { readCrawlerRenderStatus } from "./reads";
import type { CrawlerRenderStatusEntry } from "./rows";
import { logMonitorRunFailure } from "./telemetry";
import type { PropertyMonitorReport } from "./types";

/**
 * M5 Crawler + render-visibility monitoring server actions (doc 05 M5, doc 07
 * §1.4). Same security posture as the M2 audit actions
 * (src/lib/intelligence/audit/actions.ts):
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends
 *    only a propertyId; the tenant comes from the caller's VERIFIED JWT claim,
 *    and RLS (`alerts_*`, migration 0006) re-pins every row below us. The
 *    alert's client_id comes from the RLS-scoped property read, never the caller.
 *  - WRITE RIGHTS MIRROR THE RLS POLICY: `alerts_insert` admits any writer
 *    (`app.is_writer()` = agency_admin | operator), so the run guard is
 *    `requireOperator()`. The status read mirrors `alerts_select` (any tenant
 *    member, `app.client_scope` narrows a client_viewer), so it is `requireAuth()`.
 *  - THE CRAWL IS SERVER-SIDE over the property URL READ FROM THE DATABASE. The
 *    browser cannot point the monitor at an arbitrary URL (no SSRF-by-parameter),
 *    and the crawler's egress guard closes the internal-address class.
 *
 * M5 is PLAYBOOK-INDEPENDENT: unlike M2 it scores against no rubric (robots
 * access + render visibility are vertical-agnostic), so it applies NO Gate-1a
 * active-vertical gate and needs no client/playbook read. It monitors any
 * client website property in the tenant.
 */

export type RunPropertyMonitorResult =
  | {
      ok: true;
      /** The full per-crawler + per-page status for this pass. */
      report: PropertyMonitorReport;
      /** What persistence did with the detected blocks/risks (deduped/inserted/none). */
      alerts: PersistMonitorOutcome;
    }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "not_crawlable" | "monitor_failed";
      error: string;
    };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do, never a raw
 * Postgres/vendor string. Mirrors the audit action's copy. */
const FORBIDDEN_ERROR =
  "You do not have permission to run crawler monitoring, which is an agency staff action. Ask your admin to run it, or to change your role.";
const NOT_FOUND_ERROR =
  "We could not find that property. It may have been removed. Refresh the client's properties and try again.";
const NOT_CRAWLABLE_ERROR =
  "This property cannot be monitored. Crawler checks need a website property with a working http(s) address.";
const MONITOR_FAILED_ERROR = "We could not finish this crawler check. Check your connection and try again.";
const STATUS_NOT_FOUND_ERROR =
  "We could not find that client. It may have been removed. Refresh your client list and try again.";
const STATUS_READ_FAILED_ERROR = "We could not load crawler status. Check your connection and try again.";

export async function runPropertyMonitor(input: { propertyId: string }): Promise<RunPropertyMonitorResult> {
  // AUTHZ. requireOperator authenticates first (redirects to /login without a
  // verified claim — that redirect must propagate, so only the wrong-role case
  // is trapped; everything else, including NEXT_REDIRECT, rethrows).
  let claims;
  try {
    claims = await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  // Runtime backstop on the one caller-supplied field: a non-UUID cannot be a
  // property id, so it is definitionally not found, and junk never reaches
  // Postgres.
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
    // A failed READ is not "not found" — it is retryable.
    return { ok: false, reason: "monitor_failed", error: MONITOR_FAILED_ERROR };
  }
  if (!propertyRes.data) {
    // RLS-scoped read came back empty: nonexistent id and another tenant's id
    // are the SAME observation here — correct and intended (doc 03 §4).
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }
  const property = propertyRes.data as { id: string; client_id: string; type: string; url: string };

  // Only website properties have pages to crawl (doc 03 §3).
  if (property.type !== "website" || !isCrawlableUrl(property.url)) {
    return { ok: false, reason: "not_crawlable", error: NOT_CRAWLABLE_ERROR };
  }

  try {
    const report = await monitorProperty({
      fetchPort: liveFetchPort(),
      resolvePort: liveResolvePort(),
      startUrl: property.url,
      crawledAt: new Date().toISOString(),
    });

    // Persist any newly-detected block/render risk as `crawler_blocked` alerts
    // (deduped against open alerts). A persistence failure does NOT fail the
    // run — the live report is real and returned; alerts.kind carries the
    // outcome so the caller knows whether the write landed.
    const alerts = await persistMonitorAlerts(
      supabase,
      claims.tenantId,
      { clientId: property.client_id, propertyId: property.id },
      report
    );
    return { ok: true, report, alerts };
  } catch (err) {
    // Anything unexpected (a thrown crawl bug, an interrupted connection): one
    // redacted telemetry line, honest retryable failure, never a 500.
    logMonitorRunFailure(err);
    return { ok: false, reason: "monitor_failed", error: MONITOR_FAILED_ERROR };
  }
}

/**
 * The crawler needs an absolute http(s) URL — anything else is not a crawl
 * target. Also rejects a synchronously-recognizable internal host (an IP
 * literal in a blocked range, or `localhost`) up front, so an obvious SSRF
 * target is `not_crawlable` before we ever build a crawl (defense in depth —
 * the crawler's egress guard closes the DNS-resolving case too). No DNS here:
 * synchronous pre-check only. (Same helper as the audit action.)
 */
function isCrawlableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (hostIsBlockedLiteral(parsed.hostname)) return false;
  return true;
}

/* ------------------------------------------------------------------ */
/* Crawler/render status read (dashboard-bound)                        */
/* ------------------------------------------------------------------ */

export type CrawlerRenderStatusResult =
  | { ok: true; entries: CrawlerRenderStatusEntry[] }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

/**
 * Latest crawler/render status for a client (optionally one property). Guarded
 * by `requireAuth` ONLY — mirroring `alerts_select` honestly: reads are open to
 * any tenant member and `app.client_scope` already narrows a client_viewer to
 * its own client's alerts. RLS is the enforcement boundary; this adds nothing
 * it would have to fake.
 */
export async function getCrawlerRenderStatus(input: {
  clientId: string;
  propertyId?: string;
  includeAcknowledged?: boolean;
}): Promise<CrawlerRenderStatusResult> {
  await requireAuth();

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) {
    return { ok: false, reason: "not_found", error: STATUS_NOT_FOUND_ERROR };
  }
  // An optional property filter. A provided-but-invalid propertyId scopes to a
  // property that cannot exist, so the honest result is an empty list (respect
  // the caller's intent to scope) without touching the DB.
  let propertyId: string | undefined;
  if (typeof input?.propertyId === "string") {
    const trimmed = input.propertyId.trim();
    if (!isUuidV4(trimmed)) return { ok: true, entries: [] };
    propertyId = trimmed;
  }

  const supabase = await createClient();
  const status = await readCrawlerRenderStatus(supabase, clientId, {
    propertyId,
    includeAcknowledged: input?.includeAcknowledged === true,
  });
  if (!status.ok) {
    return { ok: false, reason: "read_failed", error: STATUS_READ_FAILED_ERROR };
  }
  return { ok: true, entries: status.entries };
}
