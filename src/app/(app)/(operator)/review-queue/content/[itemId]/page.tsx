import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon } from "lucide-react";

import { Entrance } from "@/components/moments";
import { getClaims } from "@/lib/auth/session";
import { isStaffRole } from "@/lib/auth/parse-claims";
import { isUuidV4 } from "@/lib/clients/validate";
import { authenticityVerdictView } from "@/lib/production/authenticity";
import { readContentReviewDetail } from "@/lib/production/review/detail-reads";
// Server-only member-identity seam (import only — the landed module is not modified).
import { resolveMemberId } from "@/lib/production/review/persist";
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
  CONTENT_TYPE_NOUN,
  ContentStatusPill,
  HumanizationPanel,
  medDateTime,
  VerdictPanel,
} from "../../_components/shared";
import { ReviewStatusAnnouncer } from "../../_components/announcer";
import { parseReviewFilterParts, reviewFilterQuery } from "../../_components/filter-link";
import { DecisionPanel } from "./decision-panel";

export const metadata: Metadata = {
  title: "Review draft — AEO/GEO + Brand Production OS",
  description: "Read a draft, record the gate verdicts, then approve or send it back.",
};

/**
 * Content-item review detail — the surface that makes "AI drafts, humans
 * approve" real for one draft. Reads the item RLS-scoped (a nonexistent or
 * out-of-scope id is one indistinguishable 404 — no existence oracle), renders
 * the full body, the authenticity panel, both gate verdicts (with an honest
 * stale-revision signal), and — for a writer — the decision controls.
 *
 * Deliberately quiet (doc 06 §5): no signature motion, no fabricated numbers,
 * absent ≠ zero. It reads the live row only; nothing here is sampled.
 */
export default async function ContentReviewDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { itemId } = await params;
  // The operator's queue filters ride the URL (whitelisted) so "Back to the
  // queue" returns to the filtered view, not a reset one (m5).
  const query = reviewFilterQuery(parseReviewFilterParts(await searchParams));
  if (!isUuidV4(itemId)) notFound();

  const supabase = await tryCreateClient();
  if (!supabase) {
    return (
      <PageContainer>
        <BackLink query={query} />
        <PanelCard title="Review draft">
          <FailedState subject="this draft" />
        </PanelCard>
      </PageContainer>
    );
  }

  const [claims, read] = await Promise.all([
    getClaims(),
    readContentReviewDetail(supabase, itemId),
  ]);

  if (!read.ok) {
    return (
      <PageContainer>
        <BackLink query={query} />
        <PanelCard title="Review draft">
          <FailedState subject="this draft" />
        </PanelCard>
      </PageContainer>
    );
  }
  if (!read.detail) notFound();

  const detail = read.detail;
  const names = await resolveClientNames(supabase, [detail.clientId]);
  const clientName = names.get(detail.clientId) ?? "A client";

  // Writer roles (agency_admin | operator) mirror the action floor; everyone
  // else — incl. platform_owner reaching the operator shell — reads only.
  const canDecide = claims != null && isStaffRole(claims.role);

  const humanizationView = authenticityVerdictView(detail.humanization);
  const humanizationPasses = humanizationView ? humanizationView.passes : null;

  // m4: name the approver on the approved state. tenant_users stores NO display
  // name/email (frozen shape), so the honest resolvable identity is "you" (the
  // caller's own member row — the same resolveMemberId seam the actions stamp
  // approved_by from) vs. an honest "a teammate" fallback. A display-name column
  // is a post-freeze schema decision, flagged — never fabricated here.
  let approvedLine: string | null = null;
  if (
    (detail.status === "approved" || detail.status === "published") &&
    detail.approvedBy != null
  ) {
    const selfMemberId = claims?.sub ? await resolveMemberId(supabase, claims.sub) : null;
    const who = selfMemberId != null && selfMemberId === detail.approvedBy ? "you" : "a teammate";
    approvedLine = `Approved by ${who} · ${medDateTime(detail.approvedAt)}`;
  }

  const title = detail.title ?? "Untitled";

  return (
    <PageContainer>
      <ReviewStatusAnnouncer />
      <BackLink query={query} />

      <Entrance step={0}>
        <PageHeader
          eyebrow={clientName}
          title={title}
          description={`${CONTENT_TYPE_NOUN[detail.type] ?? detail.type} · updated ${medDateTime(
            detail.updatedAt
          )}`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <ContentStatusPill status={detail.status} />
              <StatusPill tone="muted">{AUTOMATION_LABEL[detail.automationLevel]}</StatusPill>
            </div>
          }
        />
      </Entrance>

      {detail.status === "needs_revision" ? (
        <SendBackNotes quality={detail.quality} compliance={detail.compliance} />
      ) : null}

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <PanelCard
          title="Draft"
          description={detail.title == null ? "This draft has no title yet." : undefined}
        >
          {detail.body.trim() === "" ? (
            <p className="text-sm text-muted">This draft has no body content.</p>
          ) : (
            <div className="max-w-prose text-sm leading-6 whitespace-pre-wrap text-ink">
              {detail.body}
            </div>
          )}
        </PanelCard>

        <div className="flex flex-col gap-6">
          <PanelCard title="Authenticity">
            <HumanizationPanel view={humanizationView} />
          </PanelCard>

          <PanelCard
            title="Review gates"
            description="Both gates must pass against this exact revision before approval"
          >
            <div className="flex flex-col gap-3">
              <VerdictPanel gate="quality" verdict={detail.quality} currentBodyHash={detail.bodyHash} />
              <VerdictPanel
                gate="compliance"
                verdict={detail.compliance}
                currentBodyHash={detail.bodyHash}
              />
            </div>
          </PanelCard>
        </div>
      </section>

      <PanelCard title="Your decision">
        <DecisionPanel
          contentItemId={detail.id}
          status={detail.status}
          canDecide={canDecide}
          type={detail.type}
          automationLevel={detail.automationLevel}
          bodyHash={detail.bodyHash}
          quality={
            detail.quality
              ? { passed: detail.quality.passed, bodyHash: detail.quality.bodyHash }
              : null
          }
          compliance={
            detail.compliance
              ? { passed: detail.compliance.passed, bodyHash: detail.compliance.bodyHash }
              : null
          }
          humanizationPasses={humanizationPasses}
          approvedLine={approvedLine}
        />
      </PanelCard>
    </PageContainer>
  );
}

/**
 * needs_revision send-back notes (Orchestrator BINDING condition): a row sent
 * back MUST render its bound note(s) — from whichever gate verdict(s) carry
 * passed:false — both when both gates failed. Without this the state dead-ends.
 * An honest fallback covers the (shouldn't-happen) case where no note rode the
 * demotion, so the surface never silently strands the writer.
 */
function SendBackNotes({
  quality,
  compliance,
}: {
  quality: { passed: boolean | null; note: string | null; reviewedAt: string | null } | null;
  compliance: { passed: boolean | null; note: string | null; reviewedAt: string | null } | null;
}) {
  const entries: Array<{ gate: string; note: string | null; at: string | null }> = [];
  if (quality?.passed === false) {
    entries.push({ gate: "Content quality", note: quality.note, at: quality.reviewedAt });
  }
  if (compliance?.passed === false) {
    entries.push({ gate: "Compliance", note: compliance.note, at: compliance.reviewedAt });
  }

  return (
    <div className="rounded-xl border border-accent-warm/40 bg-overlay p-5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-ink">Sent back for revision</span>
        <StatusPill tone="warm">Needs the writer</StatusPill>
      </div>
      {entries.length === 0 ? (
        <p className="mt-2 text-sm leading-6 text-muted">
          This draft was sent back for revision, but no note was recorded with
          it. Send it back again with a reason so the writer knows what to change.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3">
          {entries.map((entry) => (
            <li key={entry.gate} className="flex flex-col gap-1">
              <span className="font-mono text-[11px] tracking-wide text-muted uppercase">
                From {entry.gate} · {medDateTime(entry.at)}
              </span>
              {entry.note ? (
                <p className="text-sm leading-6 whitespace-pre-wrap text-ink">{entry.note}</p>
              ) : (
                <p className="text-sm leading-6 text-muted">No note was recorded for this gate.</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
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
