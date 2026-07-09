"use server";

import { AuthorizationError, requireAuth, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import { hostIsBlockedLiteral } from "@/lib/intelligence/crawl";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import type { AuditResult } from "@/lib/skills/aeo-audit";
import { createClient } from "@/lib/supabase/server";
import type { SeedVertical } from "@/lib/types/playbook";
import { auditProperty } from "./engine";
import { liveFetchPort, liveResolvePort } from "./live-fetch";
import { logAuditFailure, persistAudit, readAuditHistory } from "./persist";
import type { AuditHistoryEntry } from "./rows";

/**
 * M2 Audit Engine server actions (doc 05 M2, doc 07 §1.4). Same security
 * posture as the plans actions (src/lib/plans/actions.ts):
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser
 *    sends only a propertyId; the tenant comes from the caller's VERIFIED JWT
 *    claim, and RLS (`audits_*` policies, migration 0005) re-pins every row
 *    below us regardless. The client_id on the stored row comes from the
 *    RLS-scoped property read — never from the caller.
 *  - WRITE RIGHTS MIRROR THE RLS POLICY HONESTLY: `audits_insert` admits any
 *    writer (`app.is_writer()` = agency_admin | operator, migration 0005), so
 *    the guard is `requireOperator()` (both staff roles). This deliberately
 *    DIFFERS from plan regeneration's stricter admin-only guard: running an
 *    audit is a module action operators are hired to run (doc 03 §2 role
 *    matrix), not client-record management.
 *  - THE CRAWL IS SERVER-SIDE over the shared FetchPort against the property
 *    URL READ FROM THE DATABASE — the browser cannot point the crawler at an
 *    arbitrary URL (no SSRF-by-parameter; changing a property URL is a
 *    separate, admin-gated write path).
 *
 * Honesty (M2 hard rule): scores and impact estimates come from the frozen
 * aeo-audit skill only, and every result carries the per-page crawl-coverage
 * record. A crawl that read ZERO pages is returned as an explicit failure
 * with that record — never persisted, because a "score" computed from no
 * pages would poison the very trend line this table exists to hold.
 */

/**
 * Result contract for `runPropertyAudit` — the frontend consumes this exact
 * shape. Post-handoff changes require Orchestrator + Code Review sign-off
 * (CLAUDE.md rule 1).
 */
export type RunPropertyAuditResult =
  | {
      ok: true;
      /** History row id; null when the save failed (see saveWarning). */
      auditId: string | null;
      /** The skill's scored result, verbatim. */
      audit: AuditResult;
      /** Per-page crawl honesty — what the audit is (and is not) based on. */
      coverage: CrawlCoverage;
      /** Present iff the audit ran but the history write failed. */
      saveWarning?: string;
    }
  | {
      ok: false;
      reason: "forbidden" | "not_found" | "not_crawlable" | "no_playbook" | "crawl_failed" | "audit_failed";
      error: string;
      /** Present on crawl_failed: the per-page record of what was refused/unreachable. */
      coverage?: CrawlCoverage;
    };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do, never a
 * raw Postgres/vendor string. The no-playbook line mirrors the plans copy so
 * the product speaks about Gate 1a with one voice. */
const FORBIDDEN_ERROR =
  "You don’t have permission to run audits — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const NOT_FOUND_ERROR =
  "We couldn’t find that property. It may have been removed — refresh the client’s properties and try again.";
const NOT_CRAWLABLE_ERROR =
  "This property can’t be crawled — audits need a website property with a working http(s) address.";
const NO_PLAYBOOK_ERROR =
  "No active playbook for this industry yet, so there’s no rubric to score against. Audits activate once this vertical’s playbook ships.";
const CRAWL_FAILED_ERROR =
  "We couldn’t read any pages from this site — everything we tried was blocked or didn’t answer. Check the property URL and the site’s robots.txt, then try again.";
const AUDIT_FAILED_ERROR = "We couldn’t finish this audit. Check your connection and try again.";
const CLIENT_NOT_FOUND_ERROR =
  "We couldn’t find that client. It may have been removed — refresh your client list and try again.";
const HISTORY_FAILED_ERROR = "We couldn’t load audit history. Check your connection and try again.";

/**
 * Gate 1a mirror (doc 02 "Validation-first rollout") — same gate as
 * src/lib/plans/persist.ts (module-private there): only ACTIVE verticals are
 * served; dormant/unknown verticals get no audit rubric.
 */
function activePlaybook(vertical: string) {
  return (ACTIVE_VERTICALS as readonly string[]).includes(vertical)
    ? getPlaybook(vertical as SeedVertical)
    : null;
}

export async function runPropertyAudit(input: {
  propertyId: string;
}): Promise<RunPropertyAuditResult> {
  // AUTHZ. requireOperator authenticates first (redirects to /login without a
  // verified claim — that redirect must propagate, so only the wrong-role
  // case is trapped; everything else, including NEXT_REDIRECT, rethrows).
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
  // property id, so it is definitionally not found — and junk never reaches
  // Postgres (same posture as the plans clamp).
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
    // A failed READ is not "not found" — it's retryable, and claiming the
    // property is gone would be a lie in interface voice.
    return { ok: false, reason: "audit_failed", error: AUDIT_FAILED_ERROR };
  }
  if (!propertyRes.data) {
    // RLS-scoped read came back empty: nonexistent id and another tenant's id
    // are the SAME observation here — correct and intended (doc 03 §4).
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }
  const property = propertyRes.data as { id: string; client_id: string; type: string; url: string };

  // Only website properties have pages to crawl (doc 03 §3: gbp/social
  // properties are other modules' surfaces).
  if (property.type !== "website" || !isCrawlableUrl(property.url)) {
    return { ok: false, reason: "not_crawlable", error: NOT_CRAWLABLE_ERROR };
  }

  const clientRes = await supabase
    .from("clients")
    .select("id, name, vertical")
    .eq("id", property.client_id)
    .maybeSingle();
  if (clientRes.error) {
    return { ok: false, reason: "audit_failed", error: AUDIT_FAILED_ERROR };
  }
  if (!clientRes.data) {
    // Structurally unexpected (composite FK guarantees the client exists),
    // but an RLS-empty read maps honestly to not_found, never a throw.
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }
  const client = clientRes.data as { id: string; name: string; vertical: string };

  const playbook = activePlaybook(client.vertical);
  if (!playbook) {
    return { ok: false, reason: "no_playbook", error: NO_PLAYBOOK_ERROR };
  }

  try {
    const result = await auditProperty({
      fetchPort: liveFetchPort(),
      resolvePort: liveResolvePort(),
      startUrl: property.url,
      playbook,
      crawledAt: new Date().toISOString(),
      // Canonical entity = the operator-entered client record: on-site
      // deviations from the name we manage the client under are genuine
      // entity-consistency findings, not noise.
      entity: { name: client.name },
    });

    // HONESTY GATE: zero pages read → there is nothing this audit measured.
    // Refuse (with the per-page record of why) instead of persisting a
    // trend-poisoning pseudo-score.
    if (result.coverage.crawled === 0) {
      return { ok: false, reason: "crawl_failed", error: CRAWL_FAILED_ERROR, coverage: result.coverage };
    }

    const saved = await persistAudit(
      supabase,
      claims.tenantId,
      { clientId: property.client_id, propertyId: property.id },
      playbook.version,
      result
    );
    return {
      ok: true,
      auditId: saved.auditId,
      audit: result.audit,
      coverage: result.coverage,
      ...(saved.saveWarning !== undefined ? { saveWarning: saved.saveWarning } : {}),
    };
  } catch (err) {
    // Anything unexpected (a thrown crawl bug, an interrupted connection):
    // one redacted telemetry line, honest retryable failure — never a 500.
    logAuditFailure("thrown", err);
    return { ok: false, reason: "audit_failed", error: AUDIT_FAILED_ERROR };
  }
}

/**
 * The crawler needs an absolute http(s) URL — anything else is not a crawl
 * target. Also rejects a synchronously-recognizable internal host (an IP
 * literal in a blocked range, or `localhost`) up front, so an obvious SSRF
 * target is `not_crawlable` before we ever build a crawl (defense in depth —
 * the crawler's egress guard closes the DNS-resolving case too, recording
 * `blocked_address`). No DNS here: this is the synchronous pre-check only.
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
/* Audit history — the client's trend line                             */
/* ------------------------------------------------------------------ */

/**
 * FROZEN CONTRACT — the frontend consumes this exact shape. Post-handoff
 * changes require Orchestrator + Code Review sign-off (CLAUDE.md rule 1).
 */
export type AuditHistoryResult =
  | { ok: true; entries: AuditHistoryEntry[] }
  | { ok: false; reason: "not_found" | "read_failed"; error: string };

/**
 * Newest-first audit history for a client. Guarded by `requireAuth` ONLY —
 * mirroring `audits_select` (migration 0005) honestly: reads are open to any
 * tenant member, and `app.client_scope` already narrows a client_viewer to
 * its own client's rows (the dashboard "work-done log" posture). RLS is the
 * enforcement boundary; this action adds nothing it would have to fake.
 */
export async function listAuditHistory(input: {
  clientId: string;
}): Promise<AuditHistoryResult> {
  await requireAuth();

  const clientId = typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!isUuidV4(clientId)) {
    return { ok: false, reason: "not_found", error: CLIENT_NOT_FOUND_ERROR };
  }

  const supabase = await createClient();
  const history = await readAuditHistory(supabase, clientId);
  if (!history.ok) {
    return { ok: false, reason: "read_failed", error: HISTORY_FAILED_ERROR };
  }
  return { ok: true, entries: history.entries };
}
