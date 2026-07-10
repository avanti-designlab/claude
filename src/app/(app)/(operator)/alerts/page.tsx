import type { Metadata } from "next";
import Link from "next/link";
import {
  BellRingIcon,
  BotIcon,
  CheckCircle2Icon,
  CodeXmlIcon,
  type LucideIcon,
  MessageSquareWarningIcon,
  ServerCrashIcon,
  TrendingDownIcon,
  Undo2Icon,
  UsersRoundIcon,
} from "lucide-react";

import { Entrance } from "@/components/moments";
import type { AlertSeverity, AlertType } from "@/lib/types/db";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../_components/surface";
import { resolveClientNames, tryCreateClient, type Supabase } from "../../_components/reads";
import { AcknowledgeButton } from "./_components/acknowledge-button";
import { AcknowledgeAllButton } from "./_components/acknowledge-all-button";

export const metadata: Metadata = {
  title: "Alerts — AEO/GEO + Brand Production OS",
  description: "Everything across your clients that needs a look.",
};

/**
 * Alerts (global) — the tenant-wide operator feed. Reads the `alerts` table
 * RLS-scoped (all of the caller's clients, newest first); app code writes no
 * tenant filter — the database is the boundary. Alerts record PROBLEMS only, so
 * an empty OPEN feed is an honest "nothing flagged", never an all-clear metric.
 * Most monitoring sources aren't connected yet, so the feed is empty today by
 * design.
 *
 * THE LOOP CLOSES HERE (UX audit): each open alert carries an Acknowledge control
 * (the sanctioned `acknowledgeAlert` action). Acknowledging drops the alert from
 * the open feed AND, per M5's dedup design, lets the underlying condition re-alert
 * later ("self-heals on acknowledge"). Acknowledged alerts are never lost — the
 * `?view=acknowledged` tab keeps them findable (the audit called their previous
 * vanishing "irrecoverable"). Acknowledge is deliberately one-way: there is no
 * un-acknowledge, because re-opening a row would corrupt the fingerprint dedup —
 * the acknowledged view IS the recovery path.
 */

const ALERT_META: Record<AlertType, { label: string; icon: LucideIcon }> = {
  visibility_drop: { label: "Visibility dropped", icon: TrendingDownIcon },
  competitor_overtook: {
    label: "A competitor overtook you",
    icon: UsersRoundIcon,
  },
  schema_broke: { label: "Structured data broke", icon: CodeXmlIcon },
  crawler_blocked: { label: "A crawler was blocked", icon: BotIcon },
  negative_review_spike: {
    label: "Negative review spike",
    icon: MessageSquareWarningIcon,
  },
  site_down: { label: "Site unreachable", icon: ServerCrashIcon },
  auto_rollback_fired: { label: "A change auto-rolled back", icon: Undo2Icon },
};

const SEVERITY_TONE: Record<AlertSeverity, "accent" | "warm" | "negative"> = {
  info: "accent",
  warning: "warm",
  critical: "negative",
};

/**
 * Where each alert is investigated — the client-workspace tab most relevant to
 * its type. A row links to the real destination it concerns, not the bare
 * workspace root. All segments are live workspace tabs (tabs.ts).
 */
const ALERT_TAB: Record<AlertType, string> = {
  visibility_drop: "visibility",
  competitor_overtook: "visibility",
  schema_broke: "audit",
  crawler_blocked: "crawler-health",
  negative_review_spike: "reviews",
  site_down: "crawler-health",
  auto_rollback_fired: "site-changes",
};

/**
 * Row cap for the feed — surfaced honestly when it's at the cap. Must stay ≤
 * ACTIVE_ALERTS_MAX (reads.ts), the acknowledge action's bulk-id cap, so
 * "Acknowledge all N" always covers a full page — neither number moves past the
 * other silently.
 */
const ALERT_LIMIT = 50;

type AlertView = "open" | "acknowledged";

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
function medDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

interface AlertEntry {
  id: string;
  clientId: string;
  type: AlertType;
  severity: AlertSeverity;
  createdAt: string;
}

interface AlertRawRow {
  id: string;
  client_id: string;
  type: AlertType;
  severity: AlertSeverity;
  created_at: string;
}

type Load =
  | { ok: false }
  | {
      ok: true;
      alerts: AlertEntry[];
      names: Map<string, string>;
      /** Exact DB counts per view — null when that HEAD count failed (never faked to 0). */
      openCount: number | null;
      acknowledgedCount: number | null;
    };

/** HEAD-only exact count for one view — the number can't be silently capped like a row fetch. */
async function countByAck(supabase: Supabase, acknowledged: boolean): Promise<number | null> {
  const res = await supabase
    .from("alerts")
    .select("id", { count: "exact", head: true })
    .eq("acknowledged", acknowledged);
  return res.error ? null : res.count;
}

async function load(view: AlertView): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const [rowsRes, openCount, acknowledgedCount] = await Promise.all([
      supabase
        .from("alerts")
        .select("id, client_id, type, severity, created_at")
        .eq("acknowledged", view === "acknowledged")
        .order("created_at", { ascending: false })
        .limit(ALERT_LIMIT),
      countByAck(supabase, false),
      countByAck(supabase, true),
    ]);
    if (rowsRes.error || !rowsRes.data) return { ok: false };
    const alerts: AlertEntry[] = (rowsRes.data as AlertRawRow[]).map((row) => ({
      id: row.id,
      clientId: row.client_id,
      type: row.type,
      severity: row.severity,
      createdAt: row.created_at,
    }));
    const names = await resolveClientNames(
      supabase,
      alerts.map((a) => a.clientId),
    );
    return { ok: true, alerts, names, openCount, acknowledgedCount };
  } catch {
    return { ok: false };
  }
}

function parseView(raw: Record<string, string | string[] | undefined>): AlertView {
  return raw.view === "acknowledged" ? "acknowledged" : "open";
}


export default async function AlertsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const view = parseView(await searchParams);
  const result = await load(view);

  const openCount = result.ok ? result.openCount : null;
  const acknowledgedCount = result.ok ? result.acknowledgedCount : null;
  const shownIds = result.ok ? result.alerts.map((a) => a.id) : [];
  const activeCount = view === "open" ? openCount : acknowledgedCount;
  const atCap = result.ok && result.alerts.length === ALERT_LIMIT;
  // The cap note only renders when rows were actually left out: at the cap AND
  // (count known to exceed it, or count unknown so truncation can't be ruled
  // out). Exactly ALERT_LIMIT rows with a known count of ALERT_LIMIT is a full,
  // untruncated list — no note.
  const showCapNote = atCap && (activeCount === null || activeCount > ALERT_LIMIT);

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Operations"
          title="Alerts"
          description="Visibility drops, competitor overtakes, broken schema, blocked crawlers, review spikes, and auto-rollbacks — across every client, newest first."
        />
      </Entrance>

      <Entrance step={1}>
        <ViewTabs view={view} openCount={openCount} acknowledgedCount={acknowledgedCount} />
      </Entrance>

      <Entrance step={2}>
        <PanelCard
          title={view === "open" ? "Open alerts" : "Acknowledged alerts"}
          // Attribution-neutral by necessity (Design Review Major 1): this is a
          // tenant-wide view and the schema has no acknowledged_by, so the copy
          // never implies WHO acknowledged.
          description={
            view === "open"
              ? "Only unresolved issues — acknowledge one to clear it from here (it can re-alert if the condition returns)"
              : "Acknowledged alerts — kept here so nothing is ever lost. Acknowledging is one-way; if a condition returns, a fresh alert opens in the Open tab."
          }
          aside={
            view === "open" && shownIds.length > 0 ? (
              <AcknowledgeAllButton alertIds={shownIds} />
            ) : undefined
          }
        >
          {!result.ok ? (
            <FailedState subject="alerts" />
          ) : result.alerts.length === 0 ? (
            view === "open" ? (
              <EmptyState
                icon={BellRingIcon}
                title="No open alerts"
                description="We surface issues here the moment monitoring catches one. Nothing is flagged across your clients right now."
              />
            ) : (
              <EmptyState
                icon={CheckCircle2Icon}
                title="Nothing acknowledged yet"
                description="Alerts you acknowledge from the open feed land here — a running history you can always come back to."
              />
            )
          ) : (
            <ul className="flex flex-col">
              {result.alerts.map((alert, i) => {
                const meta = ALERT_META[alert.type];
                const Icon = meta.icon;
                const name = result.names.get(alert.clientId) ?? "A client";
                return (
                  <li
                    key={alert.id}
                    className={
                      "flex items-center gap-3 py-3" +
                      (i > 0 ? " border-t border-border" : "")
                    }
                  >
                    <span
                      aria-hidden
                      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
                    >
                      <Icon className="size-4 text-muted" strokeWidth={2} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {meta.label}
                      </span>
                      <span className="block font-mono text-xs text-muted">
                        <Link
                          href={`/clients/${alert.clientId}/${ALERT_TAB[alert.type]}`}
                          className="underline-offset-4 hover:text-ink hover:underline"
                        >
                          {name}
                        </Link>{" "}
                        {/* created_at is when the alert FIRED. In the
                            acknowledged view a bare date could read as the
                            acknowledge date (which the schema can't provide),
                            so it's labeled "flagged" there. */}
                        · {view === "acknowledged" ? "flagged " : ""}
                        {medDate(alert.createdAt)}
                      </span>
                    </div>
                    {view === "open" ? (
                      <>
                        <StatusPill tone={SEVERITY_TONE[alert.severity]}>
                          {alert.severity}
                        </StatusPill>
                        <AcknowledgeButton
                          alertId={alert.id}
                          label={`${meta.label} — ${name}`}
                        />
                      </>
                    ) : (
                      // Two pills would crush the text column below `sm`
                      // (Design Review Major 2's row math) — they stack
                      // vertically there and sit side by side from `sm` up.
                      <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-2">
                        <StatusPill tone={SEVERITY_TONE[alert.severity]}>
                          {alert.severity}
                        </StatusPill>
                        <StatusPill tone="muted">Acknowledged</StatusPill>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </PanelCard>
      </Entrance>

      {showCapNote ? (
        <p className="text-xs text-muted">
          {activeCount != null
            ? `Showing the ${ALERT_LIMIT} most recent of ${activeCount} ${view === "open" ? "open" : "acknowledged"} alerts.`
            : `Showing the ${ALERT_LIMIT} most recent ${view === "open" ? "open" : "acknowledged"} alerts.`}
        </p>
      ) : null}
    </PageContainer>
  );
}

/* ------------------------------------------------------------------ */
/* View tabs (server-rendered Links — no client JS, deep-linkable)     */
/* ------------------------------------------------------------------ */

function ViewTabs({
  view,
  openCount,
  acknowledgedCount,
}: {
  view: AlertView;
  openCount: number | null;
  acknowledgedCount: number | null;
}) {
  return (
    <nav aria-label="Alert views" className="flex items-center gap-1 border-b border-border">
      <ViewTab href="/alerts" active={view === "open"} label="Open" count={openCount} />
      <ViewTab
        href="/alerts?view=acknowledged"
        active={view === "acknowledged"}
        label="Acknowledged"
        count={acknowledgedCount}
      />
    </nav>
  );
}

/**
 * One view tab — the HOUSE tab grammar (workspace-tabs.tsx): active is
 * `font-medium text-ink` with the inset rounded accent bar; inactive is
 * regular-weight `text-muted` with a color transition. The same class recipe,
 * copied — not the shared component, which is a client component (usePathname)
 * and this page is a server component. The count is an exact HEAD count when
 * known, omitted otherwise (never a faked 0), muted + tabular-nums so it reads
 * as a count rather than part of the label.
 */
function ViewTab({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number | null;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        "relative whitespace-nowrap px-3 py-2.5 text-sm transition-colors outline-none " +
        "focus-visible:ring-2 focus-visible:ring-ring/60 " +
        (active ? "font-medium text-ink" : "text-muted hover:text-ink")
      }
    >
      {label}
      {count !== null ? (
        <span className="ml-1.5 font-normal text-muted tabular-nums">{count}</span>
      ) : null}
      {active ? (
        <span
          aria-hidden
          className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-accent"
        />
      ) : null}
    </Link>
  );
}
