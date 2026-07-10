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
      names: Map<string, string>;
    };

async function load(): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const [contentRes, changesRes] = await Promise.all([
      supabase
        .from("content_items")
        .select("id, client_id, type, updated_at")
        .eq("status", "in_review")
        .order("updated_at", { ascending: false })
        .limit(50),
      supabase
        .from("site_changes")
        .select("id, client_id, change_type, method, created_at")
        .eq("status", "previewed")
        .order("created_at", { ascending: false })
        .limit(50),
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
    return { ok: true, content, changes, names };
  } catch {
    return { ok: false };
  }
}

export default async function ReviewQueuePage() {
  const result = await load();
  const total = result.ok ? result.content.length + result.changes.length : 0;

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Operations"
          title="Review & Approvals"
          description="Nothing reaches a live client site without a human decision. Content drafts and pending site changes wait here for approval or a send-back."
          actions={
            result.ok && total > 0 ? (
              <StatusPill tone="accent">{total} waiting</StatusPill>
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
              <QueueList
                items={result.content.map((item) => ({
                  id: item.id,
                  clientId: item.clientId,
                  primary: CONTENT_NOUN[item.type] ?? item.type,
                  name: result.names.get(item.clientId) ?? "A client",
                  when: medDate(item.updatedAt),
                  badge: "In review",
                }))}
              />
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
              <QueueList
                items={result.changes.map((item) => ({
                  id: item.id,
                  clientId: item.clientId,
                  primary: CHANGE_NOUN[item.changeType] ?? item.changeType,
                  name: result.names.get(item.clientId) ?? "A client",
                  when: medDate(item.createdAt),
                  badge: METHOD_LABEL[item.method] ?? item.method,
                }))}
              />
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

function QueueList({
  items,
}: {
  items: Array<{
    id: string;
    clientId: string;
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
                  href={`/clients/${item.clientId}`}
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
