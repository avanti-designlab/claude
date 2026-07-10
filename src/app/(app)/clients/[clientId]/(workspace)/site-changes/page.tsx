import type { Metadata } from "next";
import { GitCompareIcon } from "lucide-react";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  SiteChangeMethod,
  SiteChangeStatus,
  SiteChangeType,
} from "@/lib/types/db";
import {
  EmptyState,
  FailedState,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../../../_components/surface";
import { tryCreateClient } from "../../../../_components/reads";

export const metadata: Metadata = {
  title: "Site Changes — Client workspace",
};

/**
 * Site Changes tab — the change-management / auto-fix log (doc 04, doc 06 §5).
 * Reads the `site_changes` table RLS-scoped. This surface is deliberately
 * UTILITARIAN — no animation, maximum clarity — because it governs writes to a
 * live client site: every change carries a diff, a status, and (once wired)
 * one-click rollback. Nothing here is sampled; an empty log means no site
 * writes yet.
 */

const CHANGE_NOUN: Record<SiteChangeType, string> = {
  h1: "H1 heading",
  title: "Page title",
  meta: "Meta description",
  schema: "Structured data",
  alt: "Image alt text",
  content: "On-page content",
  canonical: "Canonical tag",
};

const METHOD_LABEL: Record<SiteChangeMethod, string> = {
  wordpress: "WordPress",
  webflow: "Webflow",
  wix: "Wix",
  edge_worker: "Edge worker",
  pr: "PR",
};

const STATUS_LABEL: Record<SiteChangeStatus, string> = {
  previewed: "Previewed",
  applied: "Applied",
  reverted: "Reverted",
  auto_reverted: "Auto-rolled back",
};

const STATUS_TONE: Record<
  SiteChangeStatus,
  "muted" | "accent" | "positive" | "warm" | "negative"
> = {
  previewed: "accent",
  applied: "positive",
  reverted: "warm",
  auto_reverted: "negative",
};

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
function medDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

/** Row cap for this log — surfaced honestly when the log is at the cap. */
const CHANGE_LIMIT = 60;

interface ChangeEntry {
  id: string;
  changeType: SiteChangeType;
  method: SiteChangeMethod;
  status: SiteChangeStatus;
  at: string;
}

type Load = { ok: false } | { ok: true; changes: ChangeEntry[] };

async function load(clientId: string): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const { data, error } = await supabase
      .from("site_changes")
      .select(
        "id, change_type, method, status, applied_at, reverted_at, created_at",
      )
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(CHANGE_LIMIT);
    if (error || !data) return { ok: false };
    const changes: ChangeEntry[] = (
      data as Array<{
        id: string;
        change_type: SiteChangeType;
        method: SiteChangeMethod;
        status: SiteChangeStatus;
        applied_at: string | null;
        reverted_at: string | null;
        created_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      changeType: r.change_type,
      method: r.method,
      status: r.status,
      at: r.reverted_at ?? r.applied_at ?? r.created_at,
    }));
    return { ok: true, changes };
  } catch {
    return { ok: false };
  }
}

export default async function SiteChangesTab({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const result = await load(clientId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        level="h2"
        title="Site Changes"
        description="Every write to the client's site — with a diff, a status, and one-click rollback. Nothing here goes live without a human approving the preview first."
      />

      <PanelCard
        title="Change log"
        description="Previewed, applied, and reverted changes across all connection methods"
      >
        {!result.ok ? (
          <FailedState subject="the change log" />
        ) : result.changes.length === 0 ? (
          <EmptyState
            icon={GitCompareIcon}
            title="No site changes yet"
            description="On-page and schema changes appear here as a diff you approve before it applies — with one-click rollback, and auto-rollback if a change hurts traffic or rankings."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Change</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead>Diff</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.changes.map((change) => (
                  <TableRow key={change.id}>
                    <TableCell className="font-medium text-ink">
                      {CHANGE_NOUN[change.changeType] ?? change.changeType}
                    </TableCell>
                    <TableCell className="text-muted">
                      {METHOD_LABEL[change.method] ?? change.method}
                    </TableCell>
                    <TableCell>
                      {/* No fabricated "Ready": the diff viewer is not built
                          yet, so this stays an inert em-dash — not a control
                          that implies a working diff. The visible note below
                          carries the explanation; an sr-only sibling gives
                          screen readers the same fact (aria-label/title on a
                          generic span is unreliable/mouse-only). */}
                      <span aria-hidden className="text-muted">
                        —
                      </span>
                      <span className="sr-only">
                        Diff preview isn&apos;t available yet
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted">
                      {medDate(change.at)}
                    </TableCell>
                    <TableCell className="text-right">
                      <StatusPill tone={STATUS_TONE[change.status]}>
                        {STATUS_LABEL[change.status]}
                      </StatusPill>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PanelCard>

      {result.ok && result.changes.length === CHANGE_LIMIT ? (
        <p className="text-xs text-muted">
          Showing the {CHANGE_LIMIT} most recent changes.
        </p>
      ) : null}

      <p className="max-w-3xl text-xs leading-5 text-muted">
        Diff preview and one-click rollback aren&apos;t built yet — this log
        records each change. It reads live change records only, and no write
        reaches a client site except through this change-management layer.
      </p>
    </div>
  );
}
