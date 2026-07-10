import type { Metadata } from "next";
import Link from "next/link";
import {
  BellRingIcon,
  type LucideIcon,
  PlusIcon,
  SparklesIcon,
  TargetIcon,
  UsersRoundIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ArrowButton,
  CountUpValue,
  GlowCard,
  ModeToggle,
  PipelineMini,
  StatCard,
  WashPill,
} from "@/components/dashboard-preview";
import { counterDelayMs, Entrance } from "@/components/moments";
import { guardOperatorSurface } from "@/components/app-shell/access";
import { getClaims } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { verticalLabel } from "@/lib/clients/format";
import {
  CLIENT_STATUSES,
  type ClientRow,
  type ClientStatus,
  type JwtRole,
  type PlanRow,
  TASK_STATUSES,
  type TaskRow,
  type TaskStatus,
} from "@/lib/types/db";
import { isLiveVertical, planRowVariant } from "./generate-plan-outcome";
import { GeneratePlanRow } from "./generate-plan-row";
import { StatusAnnouncer } from "./status-announcer";
import { PendingGauge, PendingModuleCard } from "./pending-module";
import {
  type RecentTask,
  RecentTaskList,
  TASK_STATUS_LABEL,
} from "./recent-tasks";

export const metadata: Metadata = {
  title: "Dashboard — AEO/GEO + Brand Production OS",
  description: "Your workspace, live — real clients, plans, and tasks.",
};

/**
 * The REAL operator dashboard — live tenant data, zero sample numbers.
 *
 * This is a Server Component reading through the RLS-scoped server client
 * (anon key + the caller's cookies), same contract as /clients: no tenant
 * filter is written in app code — `*_select` policies pin every row to
 * `app.tenant_id()` in the database. The (app) layout has already verified
 * the session before we get here.
 *
 * HONESTY RULE (non-negotiable for this page): every number rendered is read
 * from the workspace. Modules with no real data source yet (visibility score,
 * AI citations, share of voice, alerts) render an explicit "not connected
 * yet" pending state — never a placeholder metric. Zero states are
 * intentional: no clients → onboarding CTA; clients but no tasks → the
 * empty state points at onboarding a live-industry client.
 *
 * Visually this is the operator-approved preview language made real: the
 * glow hero, count-up stat tiles, and the entrance choreography — all
 * token-driven, both light and dark modes, reduced-motion renders final
 * states instantly (the moments library owns that gate).
 */

type DashboardClientRow = Pick<
  ClientRow,
  "id" | "name" | "vertical" | "status" | "locations" | "created_at"
>;

type PlanSummaryRow = Pick<
  PlanRow,
  "client_id" | "playbook_version" | "created_at"
>;

type RecentTaskRow = Pick<
  TaskRow,
  "id" | "client_id" | "module" | "automation_level" | "status" | "created_at"
>;

/** Same treatment as the clients list — kept in sync by eye (tiny). */
const STATUS_VARIANT: Record<
  ClientRow["status"],
  "default" | "secondary" | "outline"
> = {
  onboarding: "secondary",
  active: "default",
  paused: "outline",
  archived: "outline",
};

/** Forward task flow (doc 03 §3) — `reverted` is an exit, not a stage. */
const PIPELINE_FLOW = [
  "todo",
  "in_progress",
  "in_review",
  "approved",
  "published",
] as const satisfies readonly TaskStatus[];

/** How many client cards render before deferring to /clients. */
const MAX_CLIENT_CARDS = 6;

interface DashboardData {
  /** The rendered page of clients (newest first, capped at MAX_CLIENT_CARDS). */
  clients: DashboardClientRow[];
  /** Exact totals — counted in the database, never derived from fetched rows. */
  clientCount: number;
  clientStatusCounts: Record<ClientStatus, number>;
  planCount: number;
  /** Latest plan per SHOWN client (one limit-1 read each). */
  latestPlanByClient: Map<string, PlanSummaryRow>;
  taskCount: number;
  statusCounts: Record<TaskStatus, number>;
  /** Exact task load per SHOWN client; absent when zero ("None yet"). */
  taskCountsByClient: Map<string, { total: number; inReview: number }>;
  /** The limited log rows, client names resolved. */
  recentTasks: RecentTask[];
}

async function loadDashboard(): Promise<
  { ok: true; data: DashboardData } | { ok: false }
> {
  try {
    const supabase = await createClient();
    // HEAD-only exact count (carried ticket b): the database counts and zero
    // rows transfer, so the number can never be silently capped the way a
    // row fetch is — PostgREST tops out near 1,000 rows, and deriving counts
    // from fetched rows undercounts past that, breaking this page's honesty
    // rule. `count === null` is treated as a failed read, never as zero.
    const countOf = (table: "clients" | "plans" | "tasks") =>
      supabase.from(table).select("id", { count: "exact", head: true });
    const badCount = (res: { error: unknown; count: number | null }) =>
      Boolean(res.error) || res.count === null;

    // Wave 1 — the two rendered row sets (both explicitly limited) plus the
    // workspace-wide aggregates, one round-trip wave. Both status columns are
    // closed CHECK-constrained sets (migrations 0003/0004), so the per-status
    // counts partition their tables — each total is their sum, no extra query.
    const [clientsRes, recentRes, planCountRes, clientStatusRes, taskStatusRes] =
      await Promise.all([
        supabase
          .from("clients")
          .select("id, name, vertical, status, locations, created_at")
          .order("created_at", { ascending: false })
          .limit(MAX_CLIENT_CARDS),
        supabase
          .from("tasks")
          .select("id, client_id, module, automation_level, status, created_at")
          .order("created_at", { ascending: false })
          .limit(6),
        countOf("plans"),
        Promise.all(
          CLIENT_STATUSES.map((status) =>
            countOf("clients").eq("status", status)
          )
        ),
        Promise.all(
          TASK_STATUSES.map((status) => countOf("tasks").eq("status", status))
        ),
      ]);
    if (
      clientsRes.error ||
      !clientsRes.data ||
      recentRes.error ||
      !recentRes.data ||
      badCount(planCountRes) ||
      clientStatusRes.some(badCount) ||
      taskStatusRes.some(badCount)
    ) {
      return { ok: false };
    }

    const clients = clientsRes.data as DashboardClientRow[];
    const recentRows = recentRes.data as RecentTaskRow[];
    const clientStatusCounts = Object.fromEntries(
      CLIENT_STATUSES.map((status, i) => [status, clientStatusRes[i].count ?? 0])
    ) as Record<ClientStatus, number>;
    const statusCounts = Object.fromEntries(
      TASK_STATUSES.map((status, i) => [status, taskStatusRes[i].count ?? 0])
    ) as Record<TaskStatus, number>;
    const clientCount = CLIENT_STATUSES.reduce(
      (sum, status) => sum + clientStatusCounts[status],
      0
    );
    const taskCount = TASK_STATUSES.reduce(
      (sum, status) => sum + statusCounts[status],
      0
    );

    // Wave 2 — per-card detail, needing wave 1's ids. Everything here is
    // bounded: the latest plan is a limit-1 read per shown client, the task
    // loads are HEAD-only counts per shown client (indexed —
    // tasks_client_status_idx, migration 0004), and the name lookup covers at
    // most the six recent tasks' client ids. A grouped server-side aggregate
    // could collapse this fan-out to one query, but views/RPCs need the
    // post-freeze schema path — revisit if MAX_CLIENT_CARDS grows.
    const shownIds = clients.map((client) => client.id);
    const recentClientIds = [
      ...new Set(recentRows.map((task) => task.client_id)),
    ];
    const [latestPlanRes, taskTotalRes, inReviewRes, namesRes] =
      await Promise.all([
        Promise.all(
          shownIds.map((id) =>
            supabase
              .from("plans")
              .select("client_id, playbook_version, created_at")
              .eq("client_id", id)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle()
          )
        ),
        Promise.all(
          shownIds.map((id) => countOf("tasks").eq("client_id", id))
        ),
        Promise.all(
          shownIds.map((id) =>
            countOf("tasks").eq("client_id", id).eq("status", "in_review")
          )
        ),
        recentClientIds.length > 0
          ? supabase.from("clients").select("id, name").in("id", recentClientIds)
          : { data: [], error: null },
      ]);
    if (
      latestPlanRes.some((res) => res.error) ||
      taskTotalRes.some(badCount) ||
      inReviewRes.some(badCount) ||
      namesRes.error ||
      !namesRes.data
    ) {
      return { ok: false };
    }

    const latestPlanByClient = new Map<string, PlanSummaryRow>();
    for (const res of latestPlanRes) {
      if (res.data) {
        const plan = res.data as PlanSummaryRow;
        latestPlanByClient.set(plan.client_id, plan);
      }
    }

    // Absent-when-zero keeps the card's "None yet" semantics.
    const taskCountsByClient = new Map<
      string,
      { total: number; inReview: number }
    >();
    shownIds.forEach((id, i) => {
      const total = taskTotalRes[i].count ?? 0;
      if (total > 0) {
        taskCountsByClient.set(id, {
          total,
          inReview: inReviewRes[i].count ?? 0,
        });
      }
    });

    const nameById = new Map(
      (namesRes.data as Pick<ClientRow, "id" | "name">[]).map((row) => [
        row.id,
        row.name,
      ])
    );
    const recentTasks: RecentTask[] = recentRows.map((task) => ({
      ...task,
      clientName: nameById.get(task.client_id) ?? "Unknown client",
    }));

    return {
      ok: true,
      data: {
        clients,
        clientCount,
        clientStatusCounts,
        planCount: planCountRes.count ?? 0,
        latestPlanByClient,
        taskCount,
        statusCounts,
        taskCountsByClient,
        recentTasks,
      },
    };
  } catch {
    // e.g. runtime env not provisioned yet — degrade gracefully rather than 500.
    return { ok: false };
  }
}

/**
 * Mode-aware foregrounds for the glow hero — the preview's HERO treatment:
 * derived on-accent tokens on light mode's vivid-blue fill; ink/muted on dark
 * mode's navy fill. Pure token choices, never a raw white assumption.
 */
const HERO = {
  base: "text-accent-foreground dark:text-ink",
  soft: "text-accent-foreground/85 dark:text-ink/85",
  dim: "text-accent-foreground/70 dark:text-muted",
  badge:
    "border-accent-foreground/25 bg-accent-foreground/12 dark:border-ink/20 dark:bg-ink/8",
  actionCircle:
    "border-accent-foreground/25 bg-accent-foreground/14 text-accent-foreground group-hover:bg-accent-foreground group-hover:text-accent " +
    "dark:border-ink/20 dark:bg-ink/10 dark:text-ink dark:group-hover:bg-ink dark:group-hover:text-surface",
  actionLabel: "text-accent-foreground/85 dark:text-ink/80",
  actionRing:
    "focus-visible:ring-accent-foreground/70 dark:focus-visible:ring-ring/70",
};

/**
 * A hero quick-action that NAVIGATES (the preview's HeroAction, as a real
 * link): frosted circular icon, fill-invert on hover, label underneath.
 */
function HeroLink({
  href,
  icon: Icon,
  label,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={
        "group flex flex-col items-center gap-2 rounded-lg outline-none focus-visible:ring-2 " +
        HERO.actionRing
      }
    >
      <span
        aria-hidden
        className={
          "flex size-12 items-center justify-center rounded-full border " +
          "transition-[transform,box-shadow,background-color,color] duration-200 " +
          "group-hover:shadow-lg motion-safe:group-hover:-translate-y-0.5 " +
          HERO.actionCircle
        }
      >
        <Icon className="size-5" strokeWidth={2} />
      </span>
      <span className={"text-xs font-medium " + HERO.actionLabel}>{label}</span>
    </Link>
  );
}

/** Bold section heading — display face, heavy, tight (the approved look). */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <CardTitle className="font-display text-2xl leading-tight font-bold tracking-tight">
      {children}
    </CardTitle>
  );
}

/**
 * "Coming online" — the modules this dashboard will grow, named honestly
 * with what has to ship first. Rendered on every branch (even an empty
 * workspace should know what's coming).
 */
function ComingOnline({ step }: { step: number }) {
  return (
    <Entrance step={step} as="section" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl leading-tight font-bold tracking-tight text-ink">
          Coming online
        </h2>
        <p className="text-sm text-muted">
          These modules activate in later Phase 1 slices — until then they say
          so instead of showing placeholder numbers.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <PendingModuleCard
          icon={SparklesIcon}
          title="AI citations"
          description="Engine-by-engine citations (ChatGPT, Perplexity, Gemini, …) arrive with the visibility tracker (M3)."
        />
        <PendingModuleCard
          icon={TargetIcon}
          title="Share of voice"
          description="Your share of AI answers vs named competitors arrives with competitor analysis (M4)."
        />
        <PendingModuleCard
          icon={BellRingIcon}
          title="Alerts"
          description="Visibility drops, schema breaks, and crawler blocks page you when the alerting engine ships (Phase 1.8)."
        />
      </div>
    </Entrance>
  );
}

/** The standing footer disclosure — what "live" means on this page. */
function HonestyFooter() {
  return (
    <footer className="border-t border-border pt-6">
      <p className="max-w-3xl text-xs leading-5 text-muted">
        Live data only. Every number on this page is read from your workspace
        through tenant-scoped queries (RLS is the boundary) — nothing is
        sampled or projected. Modules that aren&apos;t connected yet say so.
      </p>
    </footer>
  );
}

export default async function DashboardPage() {
  // Role confinement: a client_viewer never sees the operator home — send them
  // to their own report. Staff pass through. (getClaims fails closed to null on
  // env-unset, so this never redirects during an env-less build.)
  await guardOperatorSurface();

  // The caller's verified role gates WHICH plan row each client card gets
  // (planRowVariant): `regeneratePlanForClient` is agency_admin-only, so only
  // that role sees the Generate-plan control — anyone else would collect a
  // permission error on every press. The layout already gated the session;
  // a null claim here fails closed (no control), never a 500.
  const [result, claims] = await Promise.all([loadDashboard(), getClaims()]);
  const role: JwtRole | null = claims?.role ?? null;

  /* ------------------------------------------------------------------ */
  /* Degraded: env unset or a query failed — never a 500.                */
  /* ------------------------------------------------------------------ */
  if (!result.ok) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        <Header />
        <Entrance step={1}>
          <Card className="flex flex-col items-center gap-3 border-dashed py-16 text-center">
            <p className="max-w-md px-6 text-sm text-muted">
              We couldn&apos;t load your dashboard right now. Check your
              connection and refresh — your data is safe.
            </p>
            {/* Server component, so "refresh" is a plain re-navigation — a
                full document load that re-runs every query. */}
            <Button asChild size="sm" variant="outline">
              <a href="/dashboard">Refresh</a>
            </Button>
          </Card>
        </Entrance>
      </div>
    );
  }

  const {
    clients,
    clientCount,
    clientStatusCounts,
    planCount,
    latestPlanByClient,
    taskCount,
    statusCounts,
    taskCountsByClient,
    recentTasks,
  } = result.data;

  /* ------------------------------------------------------------------ */
  /* Zero state: no clients — the hero IS the first action.              */
  /* ------------------------------------------------------------------ */
  if (clientCount === 0) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6 sm:py-10">
        <Header />
        <Entrance step={1}>
          <Card className="flex flex-col items-center gap-6 border-dashed px-6 py-16 text-center sm:py-20">
            <span className="flex size-14 items-center justify-center rounded-full bg-overlay">
              <UsersRoundIcon aria-hidden className="size-6 text-accent" />
            </span>
            <div className="flex max-w-xl flex-col gap-3">
              <h2 className="font-display text-display leading-tight font-bold tracking-[-0.02em] text-ink">
                Onboard your first client
              </h2>
              <p className="text-base text-muted">
                This dashboard lights up the moment a client exists — pick
                their industry, add locations, and reveal a real plan. No
                sample numbers here, ever.
              </p>
            </div>
            <Button asChild size="lg">
              <Link href="/onboarding">
                <PlusIcon aria-hidden /> Start onboarding
              </Link>
            </Button>
          </Card>
        </Entrance>
        <ComingOnline step={2} />
        <HonestyFooter />
      </div>
    );
  }

  /* ------------------------------------------------------------------ */
  /* Live workspace — every displayed number is an exact DB count.       */
  /* ------------------------------------------------------------------ */
  const byStatus = (status: ClientRow["status"]) => clientStatusCounts[status];
  const openTaskCount =
    statusCounts.todo + statusCounts.in_progress + statusCounts.in_review;

  const heroFacts = [
    `${byStatus("active")} active`,
    ...(byStatus("onboarding") > 0
      ? [`${byStatus("onboarding")} onboarding`]
      : []),
    ...(byStatus("paused") > 0 ? [`${byStatus("paused")} paused`] : []),
    ...(byStatus("archived") > 0 ? [`${byStatus("archived")} archived`] : []),
    `${planCount} ${planCount === 1 ? "plan" : "plans"} generated`,
    `${openTaskCount} open ${openTaskCount === 1 ? "task" : "tasks"}`,
  ];

  // Already limited to MAX_CLIENT_CARDS in the query — never sliced here.
  const shownClients = clients;
  // Entrance step accounting: header 0 · hero 1 · KPIs 2–5 · clients header 6
  // · client cards 7… · then the work row + coming-online follow.
  const afterClients = 7 + shownClients.length;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-9 px-4 py-8 sm:px-6 sm:py-10">
      <Header />

      {/* HERO — the floating glow bubble, real numbers only: the book of
          clients at display scale, workspace facts as badges, and the
          Visibility Score's honest pending ring where the resolve moment
          will live. */}
      <Entrance step={1}>
        <GlowCard surface="hero" scale="hero" bloom>
          <section
            className={
              "grid gap-10 p-7 sm:p-10 lg:grid-cols-[1.35fr_auto] lg:items-center lg:p-12 " +
              HERO.base
            }
          >
            <div className="flex flex-col gap-6">
              <span
                className={
                  "font-mono text-[11px] tracking-[0.2em] uppercase " + HERO.dim
                }
              >
                Operator dashboard · live data
              </span>
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
                  <CountUpValue
                    value={String(clientCount)}
                    delay={counterDelayMs(1)}
                    className="font-display text-display leading-[0.95] font-bold tracking-[-0.02em] tabular-nums sm:text-hero"
                  />
                  <p className={"pb-1 text-lg font-medium " + HERO.soft}>
                    {clientCount === 1
                      ? "client in your workspace"
                      : "clients in your workspace"}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {heroFacts.map((fact) => (
                    <span
                      key={fact}
                      className={
                        "inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[10px] tracking-wide uppercase " +
                        HERO.badge
                      }
                    >
                      {fact}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-start gap-5 pt-1">
                <HeroLink
                  href="/onboarding"
                  icon={PlusIcon}
                  label="Onboard a client"
                />
                <HeroLink
                  href="/clients"
                  icon={UsersRoundIcon}
                  label="View clients"
                />
              </div>
            </div>
            <div className="flex justify-center lg:justify-end">
              <PendingGauge />
            </div>
          </section>
        </GlowCard>
      </Entrance>

      {/* KPI strip — four REAL counts. No deltas or sparklines: there is no
          historical series to draw yet, and this page never fakes one. */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Entrance step={2}>
          <StatCard
            tone="glow"
            bloom
            label="Clients"
            value={String(clientCount)}
            href="/clients"
            countDelay={counterDelayMs(2)}
          />
        </Entrance>
        <Entrance step={3}>
          <StatCard
            tone="sky"
            label="Plans generated"
            value={String(planCount)}
            href={null}
            countDelay={counterDelayMs(3)}
          />
        </Entrance>
        <Entrance step={4}>
          <StatCard
            tone="plain"
            label="Open tasks"
            value={String(openTaskCount)}
            href={null}
            countDelay={counterDelayMs(4)}
          />
        </Entrance>
        <Entrance step={5}>
          <StatCard
            tone="plain"
            label="Awaiting review"
            value={String(statusCounts.in_review)}
            href={null}
            countDelay={counterDelayMs(5)}
          />
        </Entrance>
      </section>

      {/* Clients — the real content: status, vertical, locations, and each
          client's latest plan + task load. */}
      <section className="flex flex-col gap-4">
        {/* Persistent polite live region for the cards' Generate-plan
            successes. It sits OUTSIDE the card grid at a stable position, so
            router.refresh() reconciliation preserves it while the row that
            announced unmounts — see status-announcer.tsx for the mechanics. */}
        <StatusAnnouncer />
        <Entrance
          step={6}
          className="flex flex-wrap items-end justify-between gap-4"
        >
          <div className="flex flex-col gap-1">
            <h2 className="font-display text-2xl leading-tight font-bold tracking-tight text-ink">
              Clients
            </h2>
            <p className="text-sm text-muted">
              Everyone on the board, with their latest plan and task load.
            </p>
          </div>
          <ArrowButton label="View all clients" href="/clients" />
        </Entrance>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {shownClients.map((client, index) => {
            const locationCount = Array.isArray(client.locations)
              ? client.locations.length
              : 0;
            const plan = latestPlanByClient.get(client.id);
            const taskLoad = taskCountsByClient.get(client.id);
            // Which Plan row this card gets (pure, unit-tested): a healthy
            // plan's version; the Generate-plan control for agency_admin on a
            // live vertical when the client is plan-less OR holds a zero-task
            // residue plan (the tolerated partial-failure state — the
            // action's supersede path is idempotent and clears it); else the
            // quiet "None yet".
            const planVariant = planRowVariant({
              role,
              vertical: client.vertical,
              hasPlan: Boolean(plan),
              taskCount: taskLoad?.total ?? 0,
            });
            return (
              <Entrance key={client.id} step={7 + index}>
                <Card className="h-full gap-3 py-5">
                  <div className="flex flex-col gap-3 px-6">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/clients/${client.id}`}
                        className="truncate font-medium text-ink underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
                      >
                        {client.name}
                      </Link>
                      <Badge
                        variant={STATUS_VARIANT[client.status]}
                        className="shrink-0 font-mono text-[10px] uppercase"
                      >
                        {client.status}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">
                        {verticalLabel(client.vertical)}
                      </Badge>
                      <span className="text-xs text-muted">
                        {locationCount}{" "}
                        {locationCount === 1 ? "location" : "locations"}
                      </span>
                    </div>
                    <dl className="flex flex-col gap-1.5 border-t border-border pt-3 text-xs">
                      {planVariant === "generate" ? (
                        // The regeneration control (idempotent server action
                        // — a retry can never duplicate a plan).
                        <GeneratePlanRow clientId={client.id} />
                      ) : planVariant === "version" && plan ? (
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-muted">Plan</dt>
                          <dd
                            className="truncate font-mono text-ink"
                            title={`Playbook ${plan.playbook_version}`}
                          >
                            {plan.playbook_version}
                          </dd>
                        </div>
                      ) : (
                        // No plan and no control: a dormant vertical (any
                        // role) or a live one seen by a role that can't run
                        // the action. The dormant row carries its why the
                        // same way the version dd does — a native title.
                        <div className="flex items-center justify-between gap-2">
                          <dt className="text-muted">Plan</dt>
                          <dd
                            className="text-muted"
                            title={
                              isLiveVertical(client.vertical)
                                ? undefined
                                : "A plan activates when this industry’s playbook goes live."
                            }
                          >
                            None yet
                          </dd>
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <dt className="text-muted">Tasks</dt>
                        <dd className="text-ink">
                          {taskLoad
                            ? `${taskLoad.total} · ${taskLoad.inReview} in review`
                            : "None yet"}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </Card>
              </Entrance>
            );
          })}
        </div>
        {clientCount > MAX_CLIENT_CARDS ? (
          <p className="text-sm text-muted">
            Showing {MAX_CLIENT_CARDS} of {clientCount} —{" "}
            <Link
              href="/clients"
              className="font-medium text-accent underline-offset-4 hover:underline"
            >
              view all clients
            </Link>
            .
          </p>
        ) : null}
      </section>

      {/* Work row — the task pipeline by stage + the recent-tasks log. Both
          explain themselves when there are no tasks yet. items-start keeps
          each card sized to its own content on desktop — the pipeline never
          stretches to match a taller log. */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <Entrance step={afterClients}>
          <Card className="h-full">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <SectionTitle>Task pipeline</SectionTitle>
                  <CardDescription>
                    Every task by stage — nothing publishes without approval
                  </CardDescription>
                </div>
                {statusCounts.reverted > 0 ? (
                  <WashPill tone="negative">
                    {statusCounts.reverted}{" "}
                    {TASK_STATUS_LABEL.reverted.toLowerCase()}
                  </WashPill>
                ) : (
                  <WashPill tone="blue">{taskCount} total</WashPill>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              {taskCount === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
                  <p className="text-sm font-medium text-ink">No tasks yet</p>
                  <p className="max-w-sm text-xs leading-5 text-muted">
                    Tasks appear the moment a client&apos;s plan is generated —
                    onboard a client in a live industry and their roadmap lands
                    here.
                  </p>
                </div>
              ) : (
                // PipelineMini's "done" fill asserts a completed batch; on
                // live counts we only claim "work sits here" (ring) vs
                // "empty" (muted) — an honest mapping, not a progress bar.
                <PipelineMini
                  className="mx-auto w-full max-w-xl pt-3"
                  stages={PIPELINE_FLOW.map((status) => ({
                    label: TASK_STATUS_LABEL[status],
                    count: statusCounts[status],
                    state: statusCounts[status] > 0 ? "current" : "pending",
                  }))}
                />
              )}
            </CardContent>
          </Card>
        </Entrance>

        <Entrance step={afterClients + 1}>
          <Card className="h-full">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <SectionTitle>Recent tasks</SectionTitle>
                  <CardDescription>
                    The latest work items — the work-done log starts here
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {recentTasks.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
                  <p className="text-sm font-medium text-ink">
                    Nothing in the log yet
                  </p>
                  <p className="max-w-sm text-xs leading-5 text-muted">
                    Work lands here as plans generate tasks and the team moves
                    them through review.
                  </p>
                </div>
              ) : (
                <RecentTaskList tasks={recentTasks} />
              )}
            </CardContent>
          </Card>
        </Entrance>
      </section>

      <ComingOnline step={afterClients + 2} />
      <HonestyFooter />
    </div>
  );
}

/** Page header — title + the standard mode toggle (page chrome, no glow). */
function Header() {
  return (
    <Entrance step={0} className="flex flex-wrap items-end justify-between gap-4">
      <div className="flex flex-col gap-1">
        <h1 className="font-display text-3xl font-bold tracking-[-0.02em] text-ink">
          Dashboard
        </h1>
        <p className="text-sm text-muted">
          Your workspace, live — real clients, plans, and tasks. No sample
          data.
        </p>
      </div>
      <ModeToggle />
    </Entrance>
  );
}
