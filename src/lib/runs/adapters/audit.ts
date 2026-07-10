import "server-only";

/**
 * `audit` execution adapter — the canonical read-only scan the queue-infra block
 * wires end-to-end (M2 audit engine). Mirrors the operator-triggered
 * runPropertyAudit action's flow, but sourced entirely from the LEASED RUN and
 * driven through the A1 RLS-scoped per-run client:
 *
 *   leased run.property_id → read property (RLS) → read client (RLS) → resolve
 *   active playbook → crawl (socket-pinned fetch + per-page heartbeat, honest
 *   crawl budget) → score (frozen aeo-audit skill, untouched) → persist to
 *   `audits` (RLS) → return the content-free result_ref {kind:'audit', id}.
 *
 * Every read/write here is through `ctx.supabase` — the client bearing the
 * per-run minted tenant JWT — so RLS pins each row to the leased run's tenant.
 * NO service-role. Failures map to CLOSED error codes only (no URLs/messages):
 *   - missing/removed property, non-website, non-crawlable URL, no active
 *     playbook → `misconfigured` (should be caught at enqueue; defensive here);
 *   - a crawl that read ZERO pages → `crawl_refused`, or `budget_exhausted_total`
 *     when the wall-clock budget truncated it before any page (honest);
 *   - a read error or a failed history write → `engine_error` (retryable).
 */

import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import { hostIsBlockedLiteral } from "@/lib/intelligence/crawl";
import { auditProperty } from "@/lib/intelligence/audit/engine";
import { persistAudit, type Supabase as AuditSupabase } from "@/lib/intelligence/audit/persist";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import type { RunErrorCode } from "@/lib/types/db";
import type { SeedVertical } from "@/lib/types/playbook";
import { SCAN_CRAWL_BUDGET_MS } from "../config";
import { heartbeatingFetch, type AdapterContext } from "../execute";
import { RunExecutionError } from "../outcome";

interface PropertyReadRow {
  id: string;
  client_id: string;
  type: string;
  url: string;
}
interface ClientReadRow {
  id: string;
  name: string;
  vertical: string;
}

/** Gate-1a mirror (audit action): only ACTIVE verticals have a rubric. */
function activePlaybook(vertical: string) {
  return (ACTIVE_VERTICALS as readonly string[]).includes(vertical)
    ? getPlaybook(vertical as SeedVertical)
    : null;
}

/** Synchronous crawlability pre-check (matches the audit action). */
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

/** A zero-page crawl: distinguish an honest wall-clock truncation from a refusal. */
function classifyZeroPageCrawl(coverage: CrawlCoverage): RunErrorCode {
  const budgetTruncated =
    coverage.crawled === 0 && coverage.pages.some((p) => p.reason === "budget_exhausted");
  return budgetTruncated ? "budget_exhausted_total" : "crawl_refused";
}

export async function auditAdapter(ctx: AdapterContext): Promise<{ resultRef: { kind: string; id: string } }> {
  const run = ctx.run;
  if (!run.property_id) {
    throw new RunExecutionError("misconfigured", "audit run carries no property_id");
  }

  // Reads through the RLS-scoped per-run client: a property/client of ANOTHER
  // tenant is invisible (RLS), so a leaked/tampered run could never crawl it.
  const propertyRes = await ctx.supabase
    .from("properties")
    .select("id, client_id, type, url")
    .eq("id", run.property_id)
    .maybeSingle();
  if (propertyRes.error) throw new RunExecutionError("engine_error", "property read failed");
  if (!propertyRes.data) throw new RunExecutionError("misconfigured", "property not found");
  const property = propertyRes.data as PropertyReadRow;
  if (property.type !== "website" || !isCrawlableUrl(property.url)) {
    throw new RunExecutionError("misconfigured", "property is not a crawlable website");
  }

  const clientRes = await ctx.supabase
    .from("clients")
    .select("id, name, vertical")
    .eq("id", property.client_id)
    .maybeSingle();
  if (clientRes.error) throw new RunExecutionError("engine_error", "client read failed");
  if (!clientRes.data) throw new RunExecutionError("misconfigured", "client not found");
  const client = clientRes.data as ClientReadRow;

  const playbook = activePlaybook(client.vertical);
  if (!playbook) throw new RunExecutionError("misconfigured", "no active playbook for vertical");

  const result = await auditProperty({
    // Per-page heartbeat: the crawler calls this port once per page, so the
    // wrapper stamps heartbeat_at at the A6 cadence (throttled) — no crawl/**
    // change needed.
    fetchPort: heartbeatingFetch(ctx.fetchPort, ctx.heartbeat),
    resolvePort: ctx.resolvePort,
    startUrl: property.url,
    playbook,
    crawledAt: new Date(ctx.now()).toISOString(),
    entity: { name: client.name },
    // A3: the crawl truncates via its OWN honest budget, derived from the ONE
    // config constant — never a platform kill.
    bounds: { wallClockBudgetMs: SCAN_CRAWL_BUDGET_MS },
  });

  // Honesty gate (audit action parity): a zero-page crawl measured nothing.
  if (result.coverage.crawled === 0) {
    throw new RunExecutionError(classifyZeroPageCrawl(result.coverage), "crawl read zero pages");
  }

  const saved = await persistAudit(
    ctx.supabase as unknown as AuditSupabase,
    run.tenant_id,
    { clientId: property.client_id, propertyId: property.id },
    playbook.version,
    result
  );
  // A background run exists to PERSIST — a failed history write is a retryable
  // failure (no user to see a live result), unlike the interactive action's
  // fail-soft. The sweeper re-queues it under the attempt cap.
  if (!saved.auditId) throw new RunExecutionError("engine_error", "audit history write failed");

  return { resultRef: { kind: "audit", id: saved.auditId } };
}
