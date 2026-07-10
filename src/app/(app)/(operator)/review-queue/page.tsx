import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardCheckIcon, FileTextIcon, GitCompareIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Entrance } from "@/components/moments";
import type {
  ContentItemType,
  SiteChangeMethod,
  SiteChangeType,
} from "@/lib/types/db";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../_components/surface";
import { resolveClientNames, tryCreateClient } from "../../_components/reads";

export const metadata: Metadata = {
  title: "Review & Approvals — AEO/GEO + Brand Production OS",
  description: "Everything waiting on a human decision before it ships.",
};

/**
 * Review & Approval Queue (global) — the human-in-the-loop surface. "AI drafts,
 * humans approve" is a hard rule (doc 00 §2), and the data model encodes it:
 * content sits at `in_review` and site changes at `previewed` until a person
 * decides. This reads both, tenant-wide and RLS-scoped, so an operator sees
 * exactly what's waiting on them. The approve / send-back / apply actions land
 * with the review-gate wave; today this is the honest queue view.
 */

const CONTENT_NOUN: Record<ContentItemType, string> = {
  blog: "Blog post",
  faq: "FAQ",
  caption: "Social caption",
  pillar: "Pillar page",
  schema_copy: "Schema copy",
};

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

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
function medDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

/** Row cap per panel — surfaced honestly alongside the exact total below. */
const REVIEW_LIMIT = 50;

interface ContentReviewItem {
  id: string;
  clientId: string;
  type: ContentItemType;
  updatedAt: string;
}
interface ChangeReviewItem {
  id: string;
  clientId: string;
  changeType: SiteChangeType;
  method: SiteChangeMethod;
  createdAt: string;
}

type Load =
  | { ok: false }
  | {
      ok: true;
      content: ContentReviewItem[];
      changes: ChangeReviewItem[];
      /** Exact DB counts (HEAD-only) — null when the count read failed. */
      contentCount: number | null;
      changesCount: number | null;
      names: Map<string, string>;
    };

async function load(): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    // The rendered (capped) rows plus HEAD-only exact counts of the same
    // filters — so the "N waiting" pill and the truncation labels are true
    // even past the cap, not derived from the fetched page (which undercounts).
    const [contentRes, changesRes, contentCountRes, changesCountRes] =
      await Promise.all([
        supabase
          .from("content_items")
          .select("id, client_id, type, updated_at")
          .eq("status", "in_review")
          .order("updated_at", { ascending: false })
          .limit(REVIEW_LIMIT),
        supabase
          .from("site_changes")
          .select("id, client_id, change_type, method, created_at")
          .eq("status", "previewed")
          .order("created_at", { ascending: false })
          .limit(REVIEW_LIMIT),
        supabase
          .from("content_items")
          .select("id", { count: "exact", head: true })
          .eq("status", "in_review"),
        supabase
          .from("site_changes")
          .select("id", { count: "exact", head: true })
          .eq("status", "previewed"),
      ]);
    if (contentRes.error || !contentRes.data) return { ok: false };
    if (changesRes.error || !changesRes.data) return { ok: false };

    const content: ContentReviewItem[] = (
      contentRes.data as Array<{
        id: string;
        client_id: string;
        type: ContentItemType;
        updated_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      clientId: r.client_id,
      type: r.type,
      updatedAt: r.updated_at,
    }));
    const changes: ChangeReviewItem[] = (
      changesRes.data as Array<{
        id: string;
        client_id: string;
        change_type: SiteChangeType;
        method: SiteChangeMethod;
        created_at: string;
      }>
    ).map((r) => ({
      id: r.id,
      clientId: r.client_id,
      changeType: r.change_type,
      method: r.method,
      createdAt: r.created_at,
    }));

    const names = await resolveClientNames(supabase, [
      ...content.map((c) => c.clientId),
      ...changes.map((c) => c.clientId),
    ]);
    // A failed count read degrades to null (label falls back to a total-free
    // "showing first N"), never a fabricated number.
    const contentCount = contentCountRes.error ? null : contentCountRes.count;
    const changesCount = changesCountRes.error ? null : changesCountRes.count;
    return { ok: true, content, changes, contentCount, changesCount, names };
  } catch {
    return { ok: false };
  }
}

export default async function ReviewQueuePage() {
  const result = await load();
  // Exact total when the HEAD counts are available (they don't cap at the
  // fetched page); fall back to the fetched lengths only if a count read failed.
  const total = result.ok
    ? (result.contentCount ?? result.content.length) +
      (result.changesCount ?? result.changes.length)
    : 0;
  // If a count read failed while its panel sits at the row cap, `total` is a
  // LOWER BOUND, not an exact figure — the pill says "N+" rather than assert
  // a precision nobody has (honesty rule).
  const totalIsLowerBound =
    result.ok &&
    ((result.contentCount == null && result.content.length === REVIEW_LIMIT) ||
      (result.changesCount == null && result.changes.length === REVIEW_LIMIT));

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Operations"
          title="Review & Approvals"
          description="Nothing reaches a live client site without a human decision. Content drafts and pending site changes wait here for approval or a send-back."
          actions={
            result.ok && total > 0 ? (
              <StatusPill tone="accent">
                {total}
                {totalIsLowerBound ? "+" : ""} waiting
              </StatusPill>
            ) : undefined
          }
        />
      </Entrance>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <Entrance step={1}>
          <PanelCard
            title="Content awaiting review"
            description="Drafts that passed generation and are ready for quality, compliance, and your approval"
          >
            {!result.ok ? (
              <FailedState subject="the content queue" />
            ) : result.content.length === 0 ? (
              <EmptyState
                icon={FileTextIcon}
                title="No content waiting"
                description="Drafts land here as the content pipeline runs — review, then approve or send back."
              />
            ) : (
              <>
                <QueueList
                  items={result.content.map((item) => ({
                    id: item.id,
                    // No per-client content-review surface exists yet, so link
                    // to the client's Plan (roadmap) — the closest real tab for
                    // production work — not the bare workspace. A precise
                    // item-detail route lands with the review-gate wave.
                    href: `/clients/${item.clientId}/plan`,
                    primary: CONTENT_NOUN[item.type] ?? item.type,
                    name: result.names.get(item.clientId) ?? "A client",
                    when: medDate(item.updatedAt),
                    badge: "In review",
                  }))}
                />
                <TruncationNote
                  shown={result.content.length}
                  count={result.contentCount}
                />
              </>
            )}
          </PanelCard>
        </Entrance>

        <Entrance step={2}>
          <PanelCard
            title="Site changes to approve"
            description="Previewed diffs — nothing is written to a live site until a person approves it"
          >
            {!result.ok ? (
              <FailedState subject="the changes queue" />
            ) : result.changes.length === 0 ? (
              <EmptyState
                icon={GitCompareIcon}
                title="No changes waiting"
                description="On-page and schema changes appear here as a diff you approve before it applies — with one-click rollback after."
              />
            ) : (
              <>
                <QueueList
                  items={result.changes.map((item) => ({
                    id: item.id,
                    // Site changes have a real destination: the client's Site
                    // Changes tab (the change-management log).
                    href: `/clients/${item.clientId}/site-changes`,
                    primary: CHANGE_NOUN[item.changeType] ?? item.changeType,
                    name: result.names.get(item.clientId) ?? "A client",
                    when: medDate(item.createdAt),
                    badge: METHOD_LABEL[item.method] ?? item.method,
                  }))}
                />
                <TruncationNote
                  shown={result.changes.length}
                  count={result.changesCount}
                />
              </>
            )}
          </PanelCard>
        </Entrance>
      </section>

      <Entrance step={3}>
        <p className="max-w-3xl text-xs leading-5 text-muted">
          Approve, send back, and apply-with-rollback controls arrive with the
          review-gate wave. This view reads the live queue only — nothing here is
          sampled.
        </p>
      </Entrance>
    </PageContainer>
  );
}

/**
 * The honest "showing first N" affordance when a panel is at its row cap. Uses
 * the exact DB count when available ("of N"), else a total-free note — never a
 * fabricated total.
 */
function TruncationNote({
  shown,
  count,
}: {
  shown: number;
  count: number | null;
}) {
  if (shown < REVIEW_LIMIT) return null;
  // An exact count that fits within the cap means nothing is actually hidden —
  // say nothing rather than assert a truncation that didn't happen.
  if (count != null && count <= REVIEW_LIMIT) return null;
  return (
    <p className="mt-3 text-xs text-muted">
      {count != null
        ? `Showing the first ${REVIEW_LIMIT} of ${count} — newest first.`
        : `Showing the first ${REVIEW_LIMIT} — newest first.`}
    </p>
  );
}

function QueueList({
  items,
}: {
  items: Array<{
    id: string;
    /** The type-relevant destination this item concerns. */
    href: string;
    primary: string;
    name: string;
    when: string;
    badge: string;
  }>;
}) {
  return (
    <ul className="flex flex-col">
      {items.map((item, i) => (
        <li
          key={item.id}
          className={
            "flex items-center justify-between gap-3 py-3" +
            (i > 0 ? " border-t border-border" : "")
          }
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
            >
              <ClipboardCheckIcon className="size-4 text-accent" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink">
                {item.primary}
              </span>
              <span className="block font-mono text-xs text-muted">
                <Link
                  href={item.href}
                  className="underline-offset-4 hover:text-ink hover:underline"
                >
                  {item.name}
                </Link>{" "}
                · {item.when}
              </span>
            </div>
          </div>
          <Badge variant="secondary" className="shrink-0 font-mono text-[10px] uppercase">
            {item.badge}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
