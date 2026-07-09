"use server";

import { AuthorizationError, requireOperator } from "@/lib/auth/guards";
import { isUuidV4 } from "@/lib/clients/validate";
import { hostIsBlockedLiteral } from "@/lib/intelligence/crawl";
import { auditProperty } from "@/lib/intelligence/audit";
import { liveFetchPort, liveResolvePort } from "@/lib/intelligence/audit/live-fetch";
import { normalizeDomain, type CompetitorRef } from "@/lib/intelligence/visibility";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import { createClient } from "@/lib/supabase/server";
import type { SeedVertical } from "@/lib/types/playbook";
import { analyzeCompetitors, DEFAULT_COMPETITOR_CRAWL_BOUNDS } from "./analyze";
import { buildCompetitorGapReport } from "./gap-diff";
import {
  persistCompetitorGapReport,
  readLatestCompetitorCitations,
  type PersistCompetitorGapsOutcome,
} from "./persist";
import { logCompetitorFailure } from "./telemetry";
import type { CompetitorGapReport } from "./types";

/**
 * M4 Competitor citation reverse-engineering — the run server action (doc 05
 * §M4; doc 07 §1.4). Same security posture as the M2/M3 module actions:
 *
 *  - TENANT SCOPING IS CLAIM-SOURCED, NEVER CLIENT-SUPPLIED. The browser sends
 *    a propertyId (+ optional competitor refs); the tenant comes from the
 *    caller's VERIFIED JWT claim, and RLS re-pins every read below us. The
 *    client_id used comes from the RLS-scoped property/visibility reads.
 *  - WRITE/READ RIGHTS ARE STAFF (`requireOperator`: agency_admin | operator) —
 *    running a competitor analysis is bread-and-butter module work, mirroring
 *    the audit/visibility floor. (M4 writes nothing — see persist.ts — but the
 *    crawl is a rented-resource action gated to staff.)
 *  - THE CRAWLS ARE SERVER-SIDE. The CLIENT crawl targets the property URL READ
 *    FROM THE DATABASE (no SSRF-by-parameter). The COMPETITOR crawls target
 *    URLs derived from M3's STORED cited-source inventory — external and
 *    attacker-influenceable, so every one passes the SAME egress guard
 *    (analyze.ts → shared M2 crawler); the browser never points a crawler
 *    anywhere.
 *
 * HONESTY CONTRACT (the module's spine — competitive analysis lives on it):
 *  - Every gap claim traces to a crawled competitor page + the frozen rubric.
 *  - An uncrawlable competitor is EXCLUDED from denominators and reported in
 *    `report.excluded`, never counted as "signal absent" (gap-diff.ts).
 *  - The client baseline is re-audited LIVE so both sides score against the
 *    SAME rubric at the SAME time; a client crawl that read zero pages fails
 *    honestly rather than diffing against nothing.
 *  - Nothing is persisted (no frozen table fits — persist.ts); the flagged
 *    persistence gap rides in the result.
 *
 * WIRING NOTE: this action performs N+1 live crawls (client + competitors), so
 * — like the visibility tracker — it must be dispatched as a background/
 * scheduled job, never awaited inside an interactive request.
 */

/**
 * FROZEN CONTRACT — the frontend/wiring slice consumes this exact shape.
 * Post-handoff changes require Orchestrator + Code Review sign-off
 * (CLAUDE.md rule 1).
 */
export type RunCompetitorGapAnalysisResult =
  | {
      ok: true;
      report: CompetitorGapReport;
      /** The flagged persistence gap — the analysis is live-only, not stored. */
      persistence: PersistCompetitorGapsOutcome;
    }
  | {
      ok: false;
      reason:
        | "forbidden"
        | "not_found"
        | "not_crawlable"
        | "invalid_competitors"
        | "no_playbook"
        | "no_competitor_citations"
        | "client_crawl_failed"
        | "analysis_failed";
      error: string;
    };

/* Interface-voice outcomes (doc 06 §6): what happened + what to do, never a raw
 * Postgres/vendor string. Mirrors the audit/visibility copy voice. */
const FORBIDDEN_ERROR =
  "You don’t have permission to run competitor analysis — that’s an agency staff action. Ask your admin to run it, or to change your role.";
const NOT_FOUND_ERROR =
  "We couldn’t find that property. It may have been removed — refresh the client’s properties and try again.";
const NOT_CRAWLABLE_ERROR =
  "This property can’t be crawled — competitor analysis compares your site against theirs, and needs a website property with a working http(s) address.";
const INVALID_COMPETITORS_ERROR =
  "We couldn’t read the competitor list, so we didn’t run the analysis. Remove and re-add the competitors, then try again.";
const NO_PLAYBOOK_ERROR =
  "No active playbook for this industry yet, so there’s no rubric to compare against. Competitor analysis activates once this vertical’s playbook ships.";
const NO_COMPETITOR_CITATIONS_ERROR =
  "We don’t have any competitor citations to reverse-engineer yet. Run visibility tracking with named competitors first — this analysis works from what they were cited for.";
const CLIENT_CRAWL_FAILED_ERROR =
  "We couldn’t read any pages from your own site, so there’s nothing to compare against theirs. Check the property URL and the site’s robots.txt, then try again.";
const ANALYSIS_FAILED_ERROR =
  "We couldn’t finish the competitor analysis. Check your connection and try again.";

const COMPETITORS_MAX = 20;
const COMPETITOR_NAME_MAX_CHARS = 200;
const COMPETITOR_DOMAINS_MAX = 10;
/** Registrable-host shape after normalization (no schemes, paths, ports). */
const HOSTNAME_SHAPE = /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

/**
 * Hostile JSON ignores the compile-time type (house rule, visibility/actions.ts
 * + clients/validate.ts): rebuild the competitor list field-by-field — trimmed,
 * capped, host-shaped — or refuse the WHOLE payload. A malformed list is
 * refused, never silently repaired: a dropped competitor would mis-attribute
 * the stored citations M4 reverse-engineers.
 */
function sanitizeCompetitors(raw: unknown): CompetitorRef[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > COMPETITORS_MAX) return null;
  const competitors: CompetitorRef[] = [];
  const seenNames = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name === "" || name.length > COMPETITOR_NAME_MAX_CHARS) return null;
    if (seenNames.has(name.toLowerCase())) return null;
    seenNames.add(name.toLowerCase());
    if (
      !Array.isArray(record.domains) ||
      record.domains.length === 0 ||
      record.domains.length > COMPETITOR_DOMAINS_MAX
    ) {
      return null;
    }
    const domains: string[] = [];
    for (const rawDomain of record.domains) {
      if (typeof rawDomain !== "string") return null;
      const host = normalizeDomain(rawDomain);
      if (host === null || !HOSTNAME_SHAPE.test(host)) return null;
      domains.push(host);
    }
    competitors.push({ name, domains });
  }
  return competitors;
}

/** Gate 1a mirror (audit/visibility actions): dormant verticals analyze nothing. */
function activePlaybook(vertical: string) {
  return (ACTIVE_VERTICALS as readonly string[]).includes(vertical)
    ? getPlaybook(vertical as SeedVertical)
    : null;
}

/**
 * Synchronous crawl-target pre-check (same as audit/actions.ts): an absolute
 * http(s) URL that is not an obvious internal literal. The crawler's egress
 * guard closes the DNS-resolving case; this rejects the obvious target early.
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

export async function runCompetitorGapAnalysis(input: {
  /** The client's website property to audit as the baseline. */
  propertyId: string;
  /** Named competitors (name + domains) — attributes M3's stored citations. */
  competitors?: Array<{ name: string; domains: string[] }>;
}): Promise<RunCompetitorGapAnalysisResult> {
  // AUTHZ. requireOperator authenticates first (redirects to /login without a
  // verified claim — that redirect must propagate, so only the wrong-role case
  // is trapped; everything else, including NEXT_REDIRECT, rethrows).
  try {
    await requireOperator();
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { ok: false, reason: "forbidden", error: FORBIDDEN_ERROR };
    }
    throw err;
  }

  const propertyId = typeof input?.propertyId === "string" ? input.propertyId.trim() : "";
  if (!isUuidV4(propertyId)) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }
  const competitors = sanitizeCompetitors(input?.competitors);
  if (competitors === null) {
    return { ok: false, reason: "invalid_competitors", error: INVALID_COMPETITORS_ERROR };
  }

  const supabase = await createClient();
  const propertyRes = await supabase
    .from("properties")
    .select("id, client_id, type, url")
    .eq("id", propertyId)
    .maybeSingle();
  if (propertyRes.error) {
    return { ok: false, reason: "analysis_failed", error: ANALYSIS_FAILED_ERROR };
  }
  if (!propertyRes.data) {
    // RLS-scoped empty read: nonexistent and cross-tenant are the same honest
    // observation here (doc 03 §4).
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }
  const property = propertyRes.data as { id: string; client_id: string; type: string; url: string };
  if (property.type !== "website" || !isCrawlableUrl(property.url)) {
    return { ok: false, reason: "not_crawlable", error: NOT_CRAWLABLE_ERROR };
  }

  const clientRes = await supabase
    .from("clients")
    .select("id, name, vertical")
    .eq("id", property.client_id)
    .maybeSingle();
  if (clientRes.error) {
    return { ok: false, reason: "analysis_failed", error: ANALYSIS_FAILED_ERROR };
  }
  if (!clientRes.data) {
    return { ok: false, reason: "not_found", error: NOT_FOUND_ERROR };
  }
  const client = clientRes.data as { id: string; name: string; vertical: string };

  const playbook = activePlaybook(client.vertical);
  if (!playbook) {
    return { ok: false, reason: "no_playbook", error: NO_PLAYBOOK_ERROR };
  }

  // INPUT (M3 → M4): the competitor cited-URL set from the LATEST STORED
  // visibility run — M4 never re-samples citations. Empty ⇒ nothing to
  // reverse-engineer yet (honest, not a failure of the analysis).
  const citations = await readLatestCompetitorCitations(supabase, client.id, competitors);
  if (citations.kind === "failed") {
    return { ok: false, reason: "analysis_failed", error: ANALYSIS_FAILED_ERROR };
  }
  const targets = citations.latest?.competitorCitations ?? [];
  if (targets.length === 0) {
    return {
      ok: false,
      reason: "no_competitor_citations",
      error: NO_COMPETITOR_CITATIONS_ERROR,
    };
  }

  const analyzedAt = new Date().toISOString();
  try {
    // Client baseline — re-audited LIVE for an apples-to-apples comparison
    // against the same-rubric competitor crawls (M2 crawls the client's site
    // fully; the competitor crawls are shallow — conservative for the client).
    const clientResult = await auditProperty({
      fetchPort: liveFetchPort(),
      resolvePort: liveResolvePort(),
      startUrl: property.url,
      playbook,
      crawledAt: analyzedAt,
      entity: { name: client.name },
    });
    if (clientResult.coverage.crawled === 0) {
      return { ok: false, reason: "client_crawl_failed", error: CLIENT_CRAWL_FAILED_ERROR };
    }

    const competitorResults = await analyzeCompetitors({
      fetchPort: liveFetchPort(),
      resolvePort: liveResolvePort(),
      targets,
      playbook,
      crawledAt: analyzedAt,
      bounds: DEFAULT_COMPETITOR_CRAWL_BOUNDS,
    });

    const report = buildCompetitorGapReport(clientResult.audit, competitorResults, {
      playbookVertical: playbook.vertical,
      playbookVersion: playbook.version,
      analyzedAt,
    });

    return { ok: true, report, persistence: persistCompetitorGapReport() };
  } catch (err) {
    // Any thrown crawl/score bug or interrupted connection: one redacted
    // telemetry line, honest retryable failure — never a 500.
    logCompetitorFailure("thrown", err);
    return { ok: false, reason: "analysis_failed", error: ANALYSIS_FAILED_ERROR };
  }
}
