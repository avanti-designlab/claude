import type { Metadata } from "next";
import Link from "next/link";
import { FileTextIcon, GitCompareIcon, SearchXIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Entrance } from "@/components/moments";
import { isUuidV4 } from "@/lib/clients/validate";
import { parseVerdict } from "@/lib/production/review/detail-reads";
import type { ContentItemStatus, ContentItemType, SiteChangeMethod, SiteChangeType } from "@/lib/types/db";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../_components/surface";
import { resolveClientNames, tryCreateClient, type Supabase } from "../../_components/reads";
import {
  CHANGE_METHOD_LABEL,
  CHANGE_TYPE_NOUN,
  CONTENT_STATUS_LABEL,
  CONTENT_TYPE_NOUN,
  medDate,
} from "./_components/shared";
import { reviewFilterQuery } from "./_components/filter-link";
import { WARM_TEXT_CLASS } from "./_components/tone";

export const metadata: Metadata = {
  title: "Review & Approvals — AEO/GEO + Brand Production OS",
  description: "Everything waiting on a human decision before it ships.",
};

/**
 * Review & Approval Queue (global) — the human-in-the-loop surface. "AI drafts,
 * humans approve" is a hard rule (doc 00 §2). Content sits at `in_review`
 * (waiting on a verdict/approval) or `needs_revision` (sent back, waiting on the
 * writer); site changes sit at `previewed` (waiting on approval). Every row
 * links to its detail route where the decision is actually recorded.
 *
 * Filters are server-driven via searchParams (a GET form — no client-side data
 * fetching). Counts are exact HEAD reads of the same filters, so the "N waiting"
 * pill and the truncation labels stay true past the row cap.
 */

/** Row cap per panel — surfaced honestly alongside the exact total below. */
const REVIEW_LIMIT = 50;

type KindFilter = "all" | "content" | "change";
type StatusFilter = "all" | "in_review" | "needs_revision" | "previewed";

interface Filters {
  kind: KindFilter;
  status: StatusFilter;
  client?: string;
  showContent: boolean;
  showChanges: boolean;
  contentStatuses: ContentItemStatus[];
  active: boolean;
}

function parseFilters(raw: Record<string, string | string[] | undefined>): Filters {
  const kindRaw = typeof raw.kind === "string" ? raw.kind : "all";
  const kind: KindFilter = kindRaw === "content" || kindRaw === "change" ? kindRaw : "all";

  const statusRaw = typeof raw.status === "string" ? raw.status : "all";
  const status: StatusFilter =
    statusRaw === "in_review" || statusRaw === "needs_revision" || statusRaw === "previewed"
      ? statusRaw
      : "all";

  const client = typeof raw.client === "string" && isUuidV4(raw.client) ? raw.client : undefined;

  const statusIsContent = status === "in_review" || status === "needs_revision";
  const statusIsChange = status === "previewed";

  const showContent = kind !== "change" && !statusIsChange;
  const showChanges = kind !== "content" && !statusIsContent;

  const contentStatuses: ContentItemStatus[] = statusIsContent
    ? [status as ContentItemStatus]
    : ["in_review", "needs_revision"];

  return {
    kind,
    status,
    client,
    showContent,
    showChanges,
    contentStatuses,
    active: kind !== "all" || status !== "all" || client !== undefined,
  };
}

interface ContentRow {
  id: string;
  clientId: string;
  type: ContentItemType;
  status: ContentItemStatus;
  updatedAt: string;
  /** One-line send-back summary for a needs_revision row; null otherwise. */
  sendBackNote: string | null;
}
interface ChangeRow {
  id: string;
  clientId: string;
  changeType: SiteChangeType;
  method: SiteChangeMethod;
  createdAt: string;
}

type Section<T> = { ok: true; rows: T[]; count: number | null } | { ok: false };

interface ClientOption {
  id: string;
  name: string;
}

type Load =
  | { ok: false }
  | {
      ok: true;
      content: Section<ContentRow> | null;
      changes: Section<ChangeRow> | null;
      names: Map<string, string>;
      clients: ClientOption[];
    };

async function loadClientOptions(supabase: Supabase): Promise<ClientOption[]> {
  const { data, error } = await supabase
    .from("clients")
    .select("id, name")
    .order("name", { ascending: true });
  if (error || !data) return [];
  return (data as Array<{ id: string; name: string }>).map((r) => ({ id: r.id, name: r.name }));
}

async function loadContent(supabase: Supabase, filters: Filters): Promise<Section<ContentRow>> {
  let rowsQuery = supabase
    .from("content_items")
    .select("id, client_id, type, status, updated_at, quality_review, compliance_review")
    .in("status", filters.contentStatuses);
  let countQuery = supabase
    .from("content_items")
    .select("id", { count: "exact", head: true })
    .in("status", filters.contentStatuses);
  if (filters.client) {
    rowsQuery = rowsQuery.eq("client_id", filters.client);
    countQuery = countQuery.eq("client_id", filters.client);
  }

  const [rowsRes, countRes] = await Promise.all([
    rowsQuery.order("updated_at", { ascending: false }).limit(REVIEW_LIMIT),
    countQuery,
  ]);
  if (rowsRes.error || !rowsRes.data) return { ok: false };

  const rows: ContentRow[] = (
    rowsRes.data as Array<{
      id: string;
      client_id: string;
      type: ContentItemType;
      status: ContentItemStatus;
      updated_at: string;
      quality_review: unknown;
      compliance_review: unknown;
    }>
  ).map((r) => ({
    id: r.id,
    clientId: r.client_id,
    type: r.type,
    status: r.status,
    updatedAt: r.updated_at,
    sendBackNote: sendBackSummary(r.status, r.quality_review, r.compliance_review),
  }));
  return { ok: true, rows, count: countRes.error ? null : countRes.count };
}

async function loadChanges(supabase: Supabase, filters: Filters): Promise<Section<ChangeRow>> {
  let rowsQuery = supabase
    .from("site_changes")
    .select("id, client_id, change_type, method, created_at")
    .eq("status", "previewed");
  let countQuery = supabase
    .from("site_changes")
    .select("id", { count: "exact", head: true })
    .eq("status", "previewed");
  if (filters.client) {
    rowsQuery = rowsQuery.eq("client_id", filters.client);
    countQuery = countQuery.eq("client_id", filters.client);
  }

  const [rowsRes, countRes] = await Promise.all([
    rowsQuery.order("created_at", { ascending: false }).limit(REVIEW_LIMIT),
    countQuery,
  ]);
  if (rowsRes.error || !rowsRes.data) return { ok: false };

  const rows: ChangeRow[] = (
    rowsRes.data as Array<{
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
  return { ok: true, rows, count: countRes.error ? null : countRes.count };
}

/** Exact count (or a lower bound when a HEAD count failed at the row cap) for one section. */
function sectionTotal<T>(section: Section<T> | null): { n: number; lowerBound: boolean } {
  if (!section || !section.ok) return { n: 0, lowerBound: false };
  const n = section.count ?? section.rows.length;
  return { n, lowerBound: section.count == null && section.rows.length === REVIEW_LIMIT };
}

/** First failing gate's note for a needs_revision row — the queue's one-line send-back summary. */
function sendBackSummary(
  status: ContentItemStatus,
  quality: unknown,
  compliance: unknown
): string | null {
  if (status !== "needs_revision") return null;
  const q = parseVerdict(quality);
  if (q?.passed === false && q.note) return q.note;
  const c = parseVerdict(compliance);
  if (c?.passed === false && c.note) return c.note;
  return null;
}

async function load(filters: Filters): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const [clients, content, changes] = await Promise.all([
      loadClientOptions(supabase),
      filters.showContent ? loadContent(supabase, filters) : Promise.resolve(null),
      filters.showChanges ? loadChanges(supabase, filters) : Promise.resolve(null),
    ]);
    const ids = [
      ...(content?.ok ? content.rows.map((r) => r.clientId) : []),
      ...(changes?.ok ? changes.rows.map((r) => r.clientId) : []),
    ];
    const names = await resolveClientNames(supabase, ids);
    return { ok: true, content, changes, names, clients };
  } catch {
    return { ok: false };
  }
}

export default async function ReviewQueuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseFilters(await searchParams);
  const result = await load(filters);

  const content = result.ok ? sectionTotal(result.content) : { n: 0, lowerBound: false };
  const changes = result.ok ? sectionTotal(result.changes) : { n: 0, lowerBound: false };
  const total = content.n + changes.n;
  const totalIsLowerBound = content.lowerBound || changes.lowerBound;

  // Carried onto row links + returned by the detail pages' back links, so an
  // operator's filters survive the round-trip into an item and back (m5).
  const query = reviewFilterQuery({
    client: filters.client,
    kind: filters.kind === "all" ? undefined : filters.kind,
    status: filters.status === "all" ? undefined : filters.status,
  });

  // A kind=content + change-status combo (or the mirror) suppresses BOTH
  // panels — structurally zero matches, not an empty queue. Render an honest
  // no-overlap state instead of a blank page (Design Review M1).
  const filtersCannotMatch = !filters.showContent && !filters.showChanges;

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

      {result.ok ? (
        <FilterBar filters={filters} clients={result.clients} names={result.names} />
      ) : null}

      {!result.ok ? (
        <PanelCard title="The queue">
          <FailedState subject="the review queue" />
        </PanelCard>
      ) : filtersCannotMatch ? (
        <Entrance step={1}>
          <PanelCard title="Nothing can match these filters">
            <EmptyState
              icon={SearchXIcon}
              title="These filters don’t overlap"
              description="Content drafts only have content statuses, and site changes only have change statuses — so this combination can never match anything. Clear the filters, or pick a kind and status that go together."
              action={
                <Button asChild size="sm" variant="outline">
                  <Link href="/review-queue">Clear filters</Link>
                </Button>
              }
            />
          </PanelCard>
        </Entrance>
      ) : (
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
          {filters.showContent ? (
            <Entrance step={1}>
              <PanelCard
                title="Content awaiting review"
                description="Drafts in review, and drafts sent back for revision"
              >
                <ContentPanel section={result.content} names={result.names} query={query} />
              </PanelCard>
            </Entrance>
          ) : null}

          {filters.showChanges ? (
            <Entrance step={2}>
              <PanelCard
                title="Site changes to approve"
                description="Previewed diffs — nothing is written to a live site until a person approves it"
              >
                <ChangePanel section={result.changes} names={result.names} query={query} />
              </PanelCard>
            </Entrance>
          ) : null}
        </section>
      )}

      <Entrance step={3}>
        <p className="max-w-3xl text-xs leading-5 text-muted">
          Open any item to record the gate verdicts and approve or send it back.
          Site changes stay read-only previews until a property is really
          connected. This view reads the live queue only — nothing here is
          sampled.
        </p>
      </Entrance>
    </PageContainer>
  );
}

/* ------------------------------------------------------------------ */
/* Filter bar (server-rendered GET form — no client JS)               */
/* ------------------------------------------------------------------ */

// `border-input` matches the system form controls (Input/Textarea) — m6.
const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm text-ink outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function FilterBar({
  filters,
  clients,
  names,
}: {
  filters: Filters;
  clients: ClientOption[];
  names: Map<string, string>;
}) {
  // Keep a set filter selectable even if the client-options read came back empty.
  const options =
    filters.client && !clients.some((c) => c.id === filters.client)
      ? [{ id: filters.client, name: names.get(filters.client) ?? "Selected client" }, ...clients]
      : clients;

  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Client
        <select name="client" defaultValue={filters.client ?? ""} className={SELECT_CLASS}>
          <option value="">All clients</option>
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Kind
        <select name="kind" defaultValue={filters.kind} className={SELECT_CLASS}>
          <option value="all">All items</option>
          <option value="content">Content</option>
          <option value="change">Site changes</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Status
        <select name="status" defaultValue={filters.status} className={SELECT_CLASS}>
          <option value="all">Any status</option>
          <option value="in_review">In review</option>
          <option value="needs_revision">In revision</option>
          <option value="previewed">Previewed changes</option>
        </select>
      </label>
      <Button type="submit" size="sm" variant="outline">
        Apply filters
      </Button>
      {filters.active ? (
        <Link
          href="/review-queue"
          className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Clear
        </Link>
      ) : null}
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */

function ContentPanel({
  section,
  names,
  query,
}: {
  section: Section<ContentRow> | null;
  names: Map<string, string>;
  /** Active filter query, carried onto each row link (m5). */
  query: string;
}) {
  if (section == null) return null;
  if (!section.ok) return <FailedState subject="the content queue" />;
  if (section.rows.length === 0) {
    return (
      <EmptyState
        icon={FileTextIcon}
        title="No content waiting"
        description="Drafts land here as the content pipeline runs — review, then approve or send back."
      />
    );
  }
  return (
    <>
      <ul className="flex flex-col">
        {section.rows.map((item, i) => (
          <QueueRow
            key={item.id}
            href={`/review-queue/content/${item.id}${query}`}
            primary={CONTENT_TYPE_NOUN[item.type] ?? item.type}
            name={names.get(item.clientId) ?? "A client"}
            when={medDate(item.updatedAt)}
            badge={CONTENT_STATUS_LABEL[item.status]}
            note={item.sendBackNote}
            first={i === 0}
          />
        ))}
      </ul>
      <TruncationNote shown={section.rows.length} count={section.count} />
    </>
  );
}

function ChangePanel({
  section,
  names,
  query,
}: {
  section: Section<ChangeRow> | null;
  names: Map<string, string>;
  /** Active filter query, carried onto each row link (m5). */
  query: string;
}) {
  if (section == null) return null;
  if (!section.ok) return <FailedState subject="the changes queue" />;
  if (section.rows.length === 0) {
    return (
      <EmptyState
        icon={GitCompareIcon}
        title="No changes waiting"
        description="On-page and schema changes appear here as a diff you approve before it applies — with one-click rollback after."
      />
    );
  }
  return (
    <>
      <ul className="flex flex-col">
        {section.rows.map((item, i) => (
          <QueueRow
            key={item.id}
            href={`/review-queue/changes/${item.id}${query}`}
            primary={CHANGE_TYPE_NOUN[item.changeType] ?? item.changeType}
            name={names.get(item.clientId) ?? "A client"}
            when={medDate(item.createdAt)}
            badge={CHANGE_METHOD_LABEL[item.method] ?? item.method}
            note={null}
            first={i === 0}
          />
        ))}
      </ul>
      <TruncationNote shown={section.rows.length} count={section.count} />
    </>
  );
}

function QueueRow({
  href,
  primary,
  name,
  when,
  badge,
  note,
  first,
}: {
  href: string;
  primary: string;
  name: string;
  when: string;
  badge: string;
  note: string | null;
  first: boolean;
}) {
  return (
    <li className={first ? "" : "border-t border-border"}>
      <Link
        href={href}
        className="flex items-center justify-between gap-3 rounded-md px-1 py-3 outline-none hover:bg-overlay focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-ink">{primary}</span>
          <span className="truncate text-xs text-muted">
            {name} · {when}
          </span>
          {note ? (
            <span className={`mt-0.5 line-clamp-1 text-xs ${WARM_TEXT_CLASS}`}>
              Sent back: {note}
            </span>
          ) : null}
        </div>
        <Badge variant="secondary" className="shrink-0 font-mono text-[10px] uppercase">
          {badge}
        </Badge>
      </Link>
    </li>
  );
}

/**
 * Honest "showing first N" affordance when a panel is at its row cap. Uses the
 * exact DB count when available ("of N"), else a total-free note — never a
 * fabricated total.
 */
function TruncationNote({ shown, count }: { shown: number; count: number | null }) {
  if (shown < REVIEW_LIMIT) return null;
  if (count != null && count <= REVIEW_LIMIT) return null;
  return (
    <p className="mt-3 text-xs text-muted">
      {count != null
        ? `Showing the first ${REVIEW_LIMIT} of ${count} — newest first.`
        : `Showing the first ${REVIEW_LIMIT} — newest first.`}
    </p>
  );
}
