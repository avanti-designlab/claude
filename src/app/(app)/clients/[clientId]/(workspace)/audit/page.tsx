import type { Metadata } from "next";
import { FileSearchIcon } from "lucide-react";

import { readAuditHistory } from "@/lib/intelligence/audit/persist";
import {
  FailedState,
  PageHeader,
  PanelCard,
  PendingState,
} from "../../../../_components/surface";
import { tryCreateClient } from "../../../../_components/reads";

export const metadata: Metadata = {
  title: "Audit — Client workspace",
};

/**
 * Audit tab — the on-page + technical audit (M2). Reads `readAuditHistory`
 * (RLS-scoped): the client's crawl-and-score history against their playbook
 * rubric. Absent ≠ zero — no audit yet reads as pending, never as a score of 0.
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

export default async function AuditTab({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await tryCreateClient();
  const result = supabase
    ? await readAuditHistory(supabase, clientId)
    : ({ ok: false } as const);
  const latest = result.ok && result.entries.length > 0 ? result.entries[0] : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        level="h2"
        title="Audit"
        description="How the client's site scores on-page and technically against their playbook rubric — with the prioritized fixes that feed the plan."
      />

      <PanelCard
        title="Audit history"
        description="Each crawl scored against the vertical playbook, newest first"
      >
        {!result.ok ? (
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
              {result.entries.map((entry, i) => (
                <li
                  key={entry.id}
                  className={
                    "flex items-center justify-between gap-3 py-3" +
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
