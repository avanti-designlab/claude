import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Entrance } from "@/components/moments";
import { isUuidV4 } from "@/lib/clients/validate";
import { buildStructuredDiff } from "@/lib/change-management";
import type { DiffHunk, StructuredDiff } from "@/lib/change-management";
import {
  readPropertyRef,
  readSiteChangeDetail,
} from "@/lib/production/review/detail-reads";
import {
  FailedState,
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../../../_components/surface";
import { resolveClientNames, tryCreateClient } from "../../../../_components/reads";
import {
  AUTOMATION_LABEL,
  CHANGE_METHOD_LABEL,
  CHANGE_TYPE_NOUN,
  ChangeStatusPill,
  medDateTime,
} from "../../_components/shared";
import { parseReviewFilterParts, reviewFilterQuery } from "../../_components/filter-link";

export const metadata: Metadata = {
  title: "Review site change — AEO/GEO + Brand Production OS",
  description: "Inspect a previewed site change and its before/after diff.",
};

const PLATFORM_LABEL: Record<string, string> = {
  wordpress: "WordPress",
  webflow: "Webflow",
  wix: "Wix",
  framer: "Framer",
  nextjs: "Next.js",
  custom: "Custom",
};

/**
 * Site-change review detail — the change-management inspection surface (doc 04).
 * Reads one `site_changes` row RLS-scoped (null → 404, no existence oracle),
 * renders the STORED before/after diff as a real before/after view, and
 * identifies exactly which page/locator the change lands on (the "which page
 * changed" gap the audit flagged — the locator rides in the diff's `target`).
 *
 * Apply and rollback are NOT wired in this slice (their server-action seam is a
 * separately-gated connections block), so the controls render DISABLED with
 * honest copy — no phantom affordance, mirroring the Site Changes tab precedent.
 * There is no publish control anywhere: publishing is not wired.
 */
export default async function SiteChangeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ changeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { changeId } = await params;
  // The operator's queue filters ride the URL (whitelisted) so "Back to the
  // queue" returns to the filtered view, not a reset one (m5).
  const query = reviewFilterQuery(parseReviewFilterParts(await searchParams));
  if (!isUuidV4(changeId)) notFound();

  const supabase = await tryCreateClient();
  if (!supabase) {
    return (
      <PageContainer>
        <BackLink query={query} />
        <PanelCard title="Review site change">
          <FailedState subject="this change" />
        </PanelCard>
      </PageContainer>
    );
  }

  const read = await readSiteChangeDetail(supabase, changeId);
  if (!read.ok) {
    return (
      <PageContainer>
        <BackLink query={query} />
        <PanelCard title="Review site change">
          <FailedState subject="this change" />
        </PanelCard>
      </PageContainer>
    );
  }
  if (!read.detail) notFound();

  const detail = read.detail;
  const [names, propertyRes] = await Promise.all([
    resolveClientNames(supabase, [detail.clientId]),
    readPropertyRef(supabase, detail.propertyId),
  ]);
  const clientName = names.get(detail.clientId) ?? "A client";
  // c5: a FAILED property read is a temporary problem, not a missing property —
  // the two must not share the same "Not available" rendering.
  const propertyReadFailed = !propertyRes.ok;
  const property = propertyRes.ok ? propertyRes.property : null;

  const diff: StructuredDiff = buildStructuredDiff(
    detail.changeType,
    detail.target ?? { url: "" },
    detail.before,
    detail.after
  );

  // A change marked previewed but carrying an applied timestamp is the honest
  // "stuck" signal (recorded QA residual): a live-immediate write may have
  // landed while the row never advanced. It fires on real anomalies only —
  // an ordinary previewed change (no applied_at) never trips it.
  const stuckPreviewed = detail.status === "previewed" && detail.appliedAt != null;

  return (
    <PageContainer>
      <BackLink query={query} />

      <Entrance step={0}>
        <PageHeader
          eyebrow={clientName}
          title={CHANGE_TYPE_NOUN[detail.changeType] ?? detail.changeType}
          description={`${CHANGE_METHOD_LABEL[detail.method] ?? detail.method} · created ${medDateTime(
            detail.createdAt
          )}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <ChangeStatusPill status={detail.status} />
              <StatusPill tone="muted">{AUTOMATION_LABEL[detail.automationLevel]}</StatusPill>
            </div>
          }
        />
      </Entrance>

      {stuckPreviewed ? (
        <div className="rounded-xl border border-accent-warm/40 bg-overlay p-5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-ink">Needs attention</span>
            <StatusPill tone="warm">Verification did not complete</StatusPill>
          </div>
          <p className="mt-2 text-sm leading-6 text-muted">
            This change is still marked previewed but carries an applied
            timestamp ({medDateTime(detail.appliedAt)}). Its write verification
            may not have completed — check the live page before approving or
            re-running it.
          </p>
        </div>
      ) : null}

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1.6fr] lg:items-start">
        <PanelCard title="Where this change lands">
          <dl className="flex flex-col gap-3 text-sm">
            <Field label="Client">
              <Link
                href={`/clients/${detail.clientId}/site-changes`}
                className="text-ink underline-offset-4 hover:underline"
              >
                {clientName}
              </Link>
            </Field>
            <Field label="Property">
              {propertyReadFailed ? (
                // c5: temporary read failure — retryable-failure copy, never
                // mistaken for a genuinely absent property.
                <span className="text-muted">
                  Couldn&apos;t load this property right now — refresh to try
                  again.
                </span>
              ) : property ? (
                <span className="flex flex-col">
                  <span className="break-all text-ink">{property.url}</span>
                  {property.platform ? (
                    <span className="text-xs text-muted">
                      {PLATFORM_LABEL[property.platform] ?? property.platform}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="text-muted">Not available</span>
              )}
            </Field>
            <Field label="Page">
              {detail.target?.url ? (
                <span className="break-all text-ink">{detail.target.url}</span>
              ) : (
                <span className="text-muted">Not recorded on this change</span>
              )}
            </Field>
            <Field label="Locator">
              {detail.target?.locator ? (
                <span className="break-all font-mono text-xs text-ink">{detail.target.locator}</span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </Field>
            <Field label="Method">
              <span className="text-ink">{CHANGE_METHOD_LABEL[detail.method] ?? detail.method}</span>
            </Field>
            <Field label="Applied">
              <span className="text-ink">{medDateTime(detail.appliedAt)}</span>
            </Field>
            <Field label="Reverted">
              <span className="text-ink">{medDateTime(detail.revertedAt)}</span>
            </Field>
            {detail.revertedReason ? (
              <Field label="Reason">
                <span className="text-ink">{detail.revertedReason}</span>
              </Field>
            ) : null}
          </dl>
        </PanelCard>

        <PanelCard
          title="Before and after"
          description="Rendered from the stored diff — exactly what would be written"
        >
          <DiffView diff={diff} />
        </PanelCard>
      </section>

      <PanelCard title="Apply and rollback">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled aria-disabled>
              Approve and apply
            </Button>
            <Button type="button" size="sm" variant="outline" disabled aria-disabled>
              Roll back
            </Button>
          </div>
          <p className="max-w-2xl text-xs leading-5 text-muted">
            Applying this change to the live site — and one-click rollback —
            switches on once this property is really connected. Until then this
            is a read-only preview: nothing here can write to a client site.
          </p>
        </div>
      </PanelCard>
    </PageContainer>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[6rem_1fr] items-start gap-3">
      <dt className="font-mono text-[11px] tracking-wide text-muted uppercase">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * The stored before/after diff, rendered honestly: shared lines are muted,
 * removed lines read as removals, added lines as additions. Structured values
 * are shown as the deterministic JSON the diff builder produced — never a
 * prettier diff than the data supports.
 */
function DiffView({ diff }: { diff: StructuredDiff }) {
  const hasLines = diff.hunks.some((h) => h.lines.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        {diff.summary.identical
          ? "No change — before and after are identical (a no-op)."
          : `${diff.summary.linesRemoved} removed · ${diff.summary.linesAdded} added.`}
      </p>
      {!hasLines ? (
        <p className="text-sm text-muted">No content is recorded for this change.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <pre className="min-w-full text-xs leading-5">
            <code className="block">
              {diff.hunks.map((hunk, hi) =>
                hunk.lines.map((line, li) => <DiffLine key={`${hi}-${li}`} hunk={hunk} line={line} />)
              )}
            </code>
          </pre>
        </div>
      )}
    </div>
  );
}

function DiffLine({ hunk, line }: { hunk: DiffHunk; line: string }) {
  const cls =
    hunk.kind === "added"
      ? "bg-positive/10 text-positive"
      : hunk.kind === "removed"
        ? "bg-negative/10 text-negative"
        : "text-muted";
  const prefix = hunk.kind === "added" ? "+" : hunk.kind === "removed" ? "-" : " ";
  return (
    <span className={`block whitespace-pre px-3 ${cls}`}>
      {/* The +/- marker is a real diff convention, not decoration — keep it
          legible to screen readers so add/remove isn't conveyed by colour alone. */}
      <span className="mr-2 inline-block w-2 select-none opacity-70">{prefix}</span>
      {line === "" ? " " : line}
    </span>
  );
}

function BackLink({ query }: { query: string }) {
  return (
    <Link
      href={`/review-queue${query}`}
      className="inline-flex w-fit items-center gap-1.5 text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
    >
      <ArrowLeftIcon className="size-4" aria-hidden /> Back to the queue
    </Link>
  );
}
