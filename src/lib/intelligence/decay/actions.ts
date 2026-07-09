"use server";

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import { crawlSite, hostIsBlockedLiteral } from "@/lib/intelligence/crawl";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import { createClient } from "@/lib/supabase/server";
import type { SeedVertical } from "@/lib/types/playbook";
import { assessDecay } from "./assess";
import { liveFetchPort, liveResolvePort } from "./live-fetch";
import { logDecayFailure } from "./telemetry";
import type { DecayReport } from "./types";

/**
 * M6 Content decay / freshness engine — server action (doc 05 M6, doc 07 §1.4).
 *
 * SECURITY POSTURE — identical to the M2 audit action (src/lib/intelligence/
 * audit/actions.ts):
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends
 *    only a propertyId; scope comes from the caller's VERIFIED JWT claim, and
 *    RLS re-pins every row below us. The client_id / URL come from the
 *    RLS-scoped property read — never from the caller.
 *  - THE CRAWL TARGETS THE DB-STORED property URL, so the browser cannot point
 *    the crawler at an arbitrary host (no SSRF-by-parameter). A synchronous
 *    internal-host pre-check (`isCrawlableUrl`) refuses obvious SSRF targets
 *    before any crawl; the crawl layer's egress guard closes the DNS-resolving
 *    case (reused, not forked).
 *  - WRITE/READ FLOOR: guarded by `requireOperator()` (agency_admin | operator
 *    = the `app.is_writer()` staff floor). Running a live crawl is a staff
 *    module action operators are hired to run — the same floor the audit uses,
 *    NOT the passive client-scoped read floor. A client_viewer cannot trigger a
 *    crawl.
 *
 * content_items INTEGRATION — DELIBERATELY NEITHER READ NOR WRITTEN (honest
 * determination; see the module README). `content_items` tracks the product's
 * GENERATED drafts (blog/faq/caption/pillar/schema_copy) keyed by brand_kit,
 * with no URL/page-identity column and no decay/freshness column. It is not a
 * registry of the client's LIVE pages (which is what decays), cannot be joined
 * to crawled URLs, and adding a decay column would be a frozen-schema change
 * (prohibited). So M6 selects NO pages from it and writes NO decay status onto
 * it — it is M6's DOWNSTREAM (M8 mints refresh drafts there when a queued
 * refresh is approved, published via the change-management layer). This action
 * touches only `properties` and `clients` (RLS-scoped reads).
 *
 * NO PERSISTENCE: the decay report is DERIVED on demand from the crawl — the
 * frozen schema has no page-level decay/freshness store, so (like M3's flagged
 * schema gaps) a decay TREND cannot be persisted today. Flagged, not worked
 * around by overloading content_items.
 */

/**
 * FROZEN CONTRACT — the frontend consumes this exact shape. Post-handoff
 * changes require Orchestrator + Code Review sign-off (CLAUDE.md rule 1).
 */
export type RunPropertyDecayScanResult =
  | {
      ok: true;
      /** The derived decay assessment (per-page + prioritized refresh queue). */
      report: DecayReport;
      /** Per-page crawl honesty — what the scan is (and is not) based on. */
      coverage: CrawlCoverage;
    }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "not_crawlable" | "no_playbook" | "crawl_failed" | "scan_failed";
      error: string;
      /** Present on crawl_failed: the per-page record of what was refused/unreachable. */
      coverage?: CrawlCoverage;
    };

/* Interface-voice outcomes (doc 06 §6) — mirror the audit copy so the product
 * speaks with one voice. */
const FORBIDDEN_ERROR =
  "You don’t have permission to scan content freshness — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const NOT_FOUND_ERROR =
  "We couldn’t find that property. It may have been removed — refresh the client’s properties and try again.";
const NOT_CRAWLABLE_ERROR =
  "This property can’t be scanned — freshness scans need a website property with a working http(s) address.";
const NO_PLAYBOOK_ERROR =
  "No active playbook for this industry yet, so there’s no refresh cadence to scan against. Freshness scans activate once this vertical’s playbook ships.";
const CRAWL_FAILED_ERROR =
  "We couldn’t read any pages from this site — everything we tried was blocked or didn’t answer. Check the property URL and the site’s robots.txt, then try again.";
const SCAN_FAILED_ERROR = "We couldn’t finish this freshness scan. Check your connection and try again.";

/**
 * Gate 1a mirror — only ACTIVE verticals are served (same gate as the audit).
 * The decay signals themselves are vertical-agnostic, but the refresh cadence
 * is playbook-scoped (doc 05) and dormant verticals aren't in live client use,
 * so a scan for one returns no_playbook rather than a default-cadence result.
 */
function activePlaybook(vertical: string) {
  return (ACTIVE_VERTICALS as readonly string[]).includes(vertical)
    ? getPlaybook(vertical as SeedVertical)
    : null;
}

export async function runPropertyDecayScan(input: { propertyId: string }): Promise<RunPropertyDecayScanResult> {
  // AUTHZ. requireOperator authenticates first (redirects to /login without a
  // verified claim — that redirect must propagate; only the wrong-role case is
  // trapped).
  try {
    await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  // Runtime backstop on the one caller-supplied field — a non-UUID cannot be a
  // property id, so it is definitionally not found and never reaches Postgres.
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
    // A failed READ is retryable — claiming the property is gone would be a lie.
    return { ok: false, reason: "scan_failed", error: SCAN_FAILED_ERROR };
  }
  if (!propertyRes.data) {
    // RLS-scoped empty read: nonexistent id and another tenant's id are the
    // SAME observation here — correct and intended (doc 03 §4).
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }
  const property = propertyRes.data as { id: string; client_id: string; type: string; url: string };

  if (property.type !== "website" || !isCrawlableUrl(property.url)) {
    return { ok: false, reason: "not_crawlable", error: NOT_CRAWLABLE_ERROR };
  }

  const clientRes = await supabase
    .from("clients")
    .select("id, vertical")
    .eq("id", property.client_id)
    .maybeSingle();
  if (clientRes.error) {
    return { ok: false, reason: "scan_failed", error: SCAN_FAILED_ERROR };
  }
  if (!clientRes.data) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }
  const client = clientRes.data as { id: string; vertical: string };

  const playbook = activePlaybook(client.vertical);
  if (!playbook) {
    return { ok: false, reason: "no_playbook", error: NO_PLAYBOOK_ERROR };
  }

  try {
    const { site, coverage } = await crawlSite({
      fetchPort: liveFetchPort(),
      resolvePort: liveResolvePort(),
      startUrl: property.url,
      crawledAt: new Date().toISOString(),
    });

    // HONESTY GATE: zero pages read → there is nothing to assess. Refuse (with
    // the per-page record of why) rather than emit an empty "all fresh" report.
    if (coverage.crawled === 0) {
      return { ok: false, reason: "crawl_failed", error: CRAWL_FAILED_ERROR, coverage };
    }

    const report = assessDecay(site, coverage);
    return { ok: true, report, coverage };
  } catch (err) {
    // Any unexpected throw: one redacted telemetry line, honest retryable
    // failure — never a 500, never a leaked payload.
    logDecayFailure("thrown", err);
    return { ok: false, reason: "scan_failed", error: SCAN_FAILED_ERROR };
  }
}

/**
 * The crawler needs an absolute http(s) URL; anything else is not a scan
 * target. Also rejects a synchronously-recognizable internal host (IP literal
 * in a blocked range, or `localhost`) up front — an obvious SSRF target is
 * not_crawlable before a crawl is ever built (defense in depth; the crawler's
 * egress guard closes the DNS-resolving case). No DNS here — synchronous
 * pre-check only. Same helper the audit action uses.
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
