import type { Metadata } from "next";
import { FileSearchIcon } from "lucide-react";

import { getClaims } from "@/lib/auth/session";
import { isStaffRole } from "@/lib/auth/parse-claims";
import { readAuditHistory } from "@/lib/intelligence/audit/persist";
import type { AuditHistoryEntry } from "@/lib/intelligence/audit/rows";
import type { RunStatus } from "@/lib/types/db";
import {
  FailedState,
  PageHeader,
  PanelCard,
  PendingState,
} from "../../../../_components/surface";
import { tryCreateClient } from "../../../../_components/reads";
import { AuditRuns, type RunProperty, type RunView } from "./_components/audit-runs";

export const metadata: Metadata = {
  title: "Audit — Client workspace",
};

/**
 * Audit tab — the on-page + technical audit (M2) PLUS the run-trigger surface.
 * Three RLS-scoped reads, independent failure domains:
 *  - `readAuditHistory` (audits): the client's crawl-and-score history. Absent ≠
 *    zero — no audit yet reads as pending, never as a score of 0.
 *  - properties: the scannable targets for the run controls (same read shape as
 *    the Overview panel).
 *  - runs: this client's recent scan work-orders (writer-only SELECT — a viewer
 *    simply gets nothing, handled as empty, never an error).
 * The run controls + live run states render in <AuditRuns> (client); a succeeded
 * run's result_ref points at an `audits` row rendered below, anchored for a jump.
 */

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
function medDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

const DATETIME_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
function medDateTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATETIME_MED.format(t) : "—";
}

/** Run kind → operator label (only `audit` is enqueuable today; map the rest so
 *  no raw kind token could ever render if an older row exists). */
const RUN_KIND_LABEL: Record<string, string> = {
  audit: "Audit",
  monitor: "Crawler check",
  decay: "Content freshness",
  local: "Local scan",
  entity: "Entity scan",
  visibility: "Visibility scan",
};

/* ------------------------------------------------------------------ */
/* Reads (each its own claim-scoped client — independent failure)      */
/* ------------------------------------------------------------------ */

type AuditLoad = { ok: true; entries: AuditHistoryEntry[] } | { ok: false };

async function loadAudit(clientId: string): Promise<AuditLoad> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  return readAuditHistory(supabase, clientId);
}

type PropertiesLoad = { ok: true; rows: RunProperty[] } | { ok: false };

async function loadProperties(clientId: string): Promise<PropertiesLoad> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const res = await supabase
      .from("properties")
      .select("id, url")
      .eq("client_id", clientId)
      .order("created_at", { ascending: true });
    if (res.error || !res.data) return { ok: false };
    const rows = (res.data as Array<{ id: string; url: string }>).map((row) => ({
      id: row.id,
      url: row.url,
    }));
    return { ok: true, rows };
  } catch {
    return { ok: false };
  }
}

/** Raw runs row (only the columns the UI needs). */
interface RawRun {
  id: string;
  kind: string;
  status: string;
  attempts: number | null;
  heartbeat_at: string | null;
  error_code: string | null;
  result_ref: unknown;
  created_at: string;
  property_id: string | null;
}

type RunsLoad = { ok: true; rows: RawRun[] } | { ok: false };

const RECENT_RUNS_MAX = 25;

async function loadRuns(clientId: string): Promise<RunsLoad> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const res = await supabase
      .from("runs")
      .select(
        "id, kind, status, attempts, heartbeat_at, error_code, result_ref, created_at, property_id"
      )
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(RECENT_RUNS_MAX);
    // Writer-only SELECT policy: a viewer gets zero rows (not an error) — that
    // lands as ok:true with an empty list, rendered as "No scans yet".
    if (res.error || !res.data) return { ok: false };
    return { ok: true, rows: res.data as RawRun[] };
  } catch {
    return { ok: false };
  }
}

/** Extract the `audits.id` from a succeeded run's content-free result_ref
 *  ({kind:'audit', id}); null for any other shape. */
function auditResultId(ref: unknown): string | null {
  if (ref && typeof ref === "object" && !Array.isArray(ref)) {
    const r = ref as Record<string, unknown>;
    if (r.kind === "audit" && typeof r.id === "string" && r.id.length > 0) {
      return r.id;
    }
  }
  return null;
}

function parseMs(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const RUN_STATUS_SET = new Set<RunStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

function mapRuns(
  rows: RawRun[],
  propertyUrlById: Map<string, string>,
  auditIds: Set<string>
): RunView[] {
  return rows
    .filter((r) => RUN_STATUS_SET.has(r.status as RunStatus))
    .map((r) => {
      const resultAuditId =
        r.status === "succeeded" ? auditResultId(r.result_ref) : null;
      return {
        id: r.id,
        status: r.status as RunStatus,
        kindLabel: RUN_KIND_LABEL[r.kind] ?? "Scan",
        attempts:
          typeof r.attempts === "number" && Number.isFinite(r.attempts) && r.attempts > 0
            ? r.attempts
            : 0,
        heartbeatAtMs: parseMs(r.heartbeat_at),
        errorCode: r.error_code,
        createdAtLabel: medDateTime(r.created_at),
        propertyUrl: r.property_id
          ? propertyUrlById.get(r.property_id) ?? null
          : null,
        resultAuditId,
        resultInHistory: resultAuditId ? auditIds.has(resultAuditId) : false,
      };
    });
}

export default async function AuditTab({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;

  const [claims, auditLoad, propertiesLoad, runsLoad] = await Promise.all([
    getClaims(),
    loadAudit(clientId),
    loadProperties(clientId),
    loadRuns(clientId),
  ]);

  const canWrite = claims ? isStaffRole(claims.role) : false;

  const auditEntries = auditLoad.ok ? auditLoad.entries : [];
  const latest = auditEntries.length > 0 ? auditEntries[0] : null;
  const auditIds = new Set(auditEntries.map((e) => e.id));

  const properties = propertiesLoad.ok ? propertiesLoad.rows : [];
  const propertyUrlById = new Map(properties.map((p) => [p.id, p.url]));
  const runViews = runsLoad.ok
    ? mapRuns(runsLoad.rows, propertyUrlById, auditIds)
    : [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        level="h2"
        title="Audit"
        description="How the client's site scores on-page and technically against their playbook rubric — with the prioritized fixes that feed the plan."
      />

      <PanelCard
        title="Scans"
        description="Queue an audit for this client's site and watch it run — results land in the history below."
      >
        <AuditRuns
          clientId={clientId}
          canWrite={canWrite}
          properties={properties}
          propertiesOk={propertiesLoad.ok}
          runs={runViews}
          runsOk={runsLoad.ok}
        />
      </PanelCard>

      <PanelCard
        title="Audit history"
        description="Each crawl scored against the vertical playbook, newest first"
      >
        {!auditLoad.ok ? (
          <FailedState subject="the audit history" />
        ) : !latest ? (
          <PendingState
            icon={FileSearchIcon}
            title="No audit yet"
            measuring="The first audit crawls the client's site, scores it against the playbook, and lists prioritized fixes here — with the score history building over time."
          />
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-end gap-6 rounded-lg border border-border bg-surface-raised px-5 py-4">
              <div className="flex flex-col">
                <span className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
                  Latest score
                </span>
                <span className="font-display text-4xl font-bold tabular-nums text-ink">
                  {latest.overallScore ?? "—"}
                </span>
              </div>
              <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
                <Metric label="Fixes queued" value={latest.fixCount ?? 0} />
                <Metric label="Pages crawled" value={latest.pagesCrawled ?? 0} />
                <Metric label="Pages failed" value={latest.pagesFailed ?? 0} />
              </dl>
            </div>
            <ul className="flex flex-col">
              {auditEntries.map((entry, i) => (
                <li
                  key={entry.id}
                  id={`audit-${entry.id}`}
                  className={
                    "flex scroll-mt-24 items-center justify-between gap-3 py-3" +
                    (i > 0 ? " border-t border-border" : "")
                  }
                >
                  <div className="flex flex-col">
                    <span className="text-sm text-ink">{medDate(entry.createdAt)}</span>
                    <span className="font-mono text-xs text-muted">
                      {entry.fixCount ?? 0} fixes · {entry.pagesCrawled ?? 0} pages
                    </span>
                  </div>
                  <span className="font-display text-xl font-bold tabular-nums text-ink">
                    {entry.overallScore ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </PanelCard>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <dt className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
        {label}
      </dt>
      <dd className="font-medium tabular-nums text-ink">{value}</dd>
    </div>
  );
}
