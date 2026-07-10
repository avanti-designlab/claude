import type { Metadata } from "next";
import Link from "next/link";
import { ClipboardListIcon, FilterXIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getClaims } from "@/lib/auth/session";
import { isStaffRole } from "@/lib/auth/parse-claims";
import type { AutomationLevel, JwtRole, TaskStatus } from "@/lib/types/db";
import { TASK_STATUSES } from "@/lib/types/db";
import type { ImpactLevel } from "@/lib/types/roadmap";
import { readTaskDetail, type TaskDetail } from "@/lib/plans/task-payload";
import {
  manualActionsFor,
  statusNote,
  type ManualAction,
} from "@/lib/plans/task-status";
import {
  EmptyState,
  FailedState,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../../../_components/surface";
import { tryCreateClient } from "../../../../_components/reads";
import {
  isLiveVertical,
  planRowVariant,
} from "../../../../dashboard/generate-plan-outcome";
import { PlanAnnouncer } from "./_components/announcer";
import { RegeneratePlanButton } from "./_components/regenerate-plan-button";
import { TaskStatusControl } from "./_components/task-status-control";

export const metadata: Metadata = {
  title: "Plan — Client workspace",
};

/**
 * Plan tab — the playbook-driven roadmap (M1), rebuilt into the operator's daily
 * workbench (P1 slice). Reads the latest `plans` row + THAT plan's `tasks`
 * (RLS-scoped, plan-scoped — Design Review m4). Every task carries its
 * automation_level (auto / ai-draft-human-approve / human-only) — the guarantee
 * that nothing publishes without a human when it should not — and its payload
 * richness (priority, effort, channel, the full description) plus, where a human
 * owns the task's status, a manual control (the sanctioned todo⇄in_progress edge).
 *
 * Honesty through-line: real payload values only (absent ≠ zero — see
 * task-payload.ts); exact HEAD counts so the filter/truncation copy stays true;
 * the LATEST plan shown, said plainly when a client carries more than one;
 * roadmap ORDER is the stored priority (Design Review M1) — a plan's tasks share
 * one bulk-insert created_at, so created_at is a total tie there and would
 * reshuffle arbitrarily on every refresh.
 */

/** Row cap for the task list — surfaced honestly when the list is at the cap. */
const TASK_LIMIT = 60;

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  approved: "Approved",
  published: "Published",
  reverted: "Reverted",
  // 'done' (0013): a human marked their own task complete — plain work-tracking,
  // never a review/publish approval (those are "Approved"/"Published").
  done: "Done",
};

/**
 * DISPLAY order for the status-filter select — a PAGE choice: "Done" reads with
 * the working stages (right after "In progress"), not trailing "Reverted".
 * Derived from TASK_STATUSES (never a reorder of it — that array mirrors the DB
 * CHECK), so every status appears exactly once and a future status can't
 * silently vanish from the filter.
 */
const STATUS_FILTER_ORDER: readonly TaskStatus[] = TASK_STATUSES.filter(
  (s) => s !== "done",
).flatMap((s) => (s === "in_progress" ? [s, "done" as TaskStatus] : [s]));

type PillTone = "muted" | "accent" | "positive" | "warm" | "negative";

const STATUS_TONE: Record<TaskStatus, PillTone> = {
  todo: "muted",
  in_progress: "accent",
  in_review: "warm",
  approved: "positive",
  published: "positive",
  reverted: "negative",
  done: "positive",
};

const AUTOMATION_LABEL: Record<AutomationLevel, string> = {
  auto: "Auto",
  ai_draft_human_approve: "AI draft · you approve",
  human_only: "Human only",
};

/** The generator's real impact scale → label + tone (matches the audit fix list). */
const IMPACT_META: Record<ImpactLevel, { label: string; tone: PillTone }> = {
  critical: { label: "Critical", tone: "negative" },
  high: { label: "High", tone: "warm" },
  medium: { label: "Medium", tone: "accent" },
  low: { label: "Low", tone: "muted" },
};

/**
 * Human labels for the module refs the plan generator stores in `tasks.module`
 * (ModuleRef — doc 05 module map). Unknown values are omitted rather than shown
 * as a raw code (same posture as the audit fix list, which never renders module
 * codes).
 */
const MODULE_LABEL: Record<string, string> = {
  M2: "Audit",
  M3: "Visibility",
  M4: "Competitors",
  M5: "Crawler health",
  M6: "Freshness",
  M8: "Content",
  M10: "Schema",
  M11: "Social",
  M12: "PR & entity",
  M14: "Local SEO",
  M15: "Reviews",
};

const SOURCE_LABEL: Record<string, string> = {
  playbook: "From the playbook",
  audit: "From an audit gap",
};

interface TaskEntry {
  id: string;
  module: string;
  automationLevel: AutomationLevel;
  status: TaskStatus;
  detail: TaskDetail;
}

interface PlanData {
  version: string | null;
  createdAt: string | null;
  /** How many plan rows this client carries — drives the "latest shown" note. */
  planCount: number;
  vertical: string | null;
  hasPlan: boolean;
  /** THIS plan's task count (plan-scoped, exact — Design Review m4). */
  totalAll: number;
  /** This plan's tasks matching the active status filter. */
  totalFiltered: number;
  tasks: TaskEntry[];
}

type Load = { ok: false } | { ok: true; data: PlanData };

/** Whitelist the status searchParam to the closed CHECK set (else "all"). */
function parseStatusFilter(
  raw: Record<string, string | string[] | undefined>,
): TaskStatus | "all" {
  const s = typeof raw.status === "string" ? raw.status : "all";
  return (TASK_STATUSES as readonly string[]).includes(s)
    ? (s as TaskStatus)
    : "all";
}

async function load(
  clientId: string,
  statusFilter: TaskStatus | "all",
): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    // Wave 1 — the shown plan (latest), how many plan versions exist, and the
    // client's vertical (drives the empty state's honesty about dormant
    // playbooks). Counts are HEAD-only exact (never derived from fetched rows);
    // count === null is a failed read, never zero.
    const [planRes, planCountRes, clientRes] = await Promise.all([
      supabase
        .from("plans")
        .select("id, playbook_version, created_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("plans")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId),
      supabase
        .from("clients")
        .select("vertical")
        .eq("id", clientId)
        .maybeSingle(),
    ]);
    if (
      planRes.error ||
      Boolean(planCountRes.error) ||
      planCountRes.count === null ||
      clientRes.error
    ) {
      return { ok: false };
    }
    const plan = planRes.data as {
      id: string;
      playbook_version: string;
      created_at: string;
    } | null;
    const vertical =
      (clientRes.data as { vertical: string } | null)?.vertical ?? null;
    const planCount = planCountRes.count ?? 0;

    if (!plan) {
      // No plan → structurally no tasks (every task requires a plan_id,
      // migration 0004), so there is nothing to read.
      return {
        ok: true,
        data: {
          version: null,
          createdAt: null,
          planCount,
          vertical,
          hasPlan: false,
          totalAll: 0,
          totalFiltered: 0,
          tasks: [],
        },
      };
    }

    // Wave 2 — THIS plan's tasks (scoped to the shown plan's id, so "this
    // plan's tasks" is exactly true and an older plan's rows never union in —
    // Design Review m4), in ROADMAP order: stored priority descending
    // (payload->priorityScore, the generator's deterministic key — it DRIVES
    // the order but never renders) with an id tiebreak so the order is stable
    // across refreshes. created_at is useless within a plan: its tasks share
    // one bulk-insert timestamp, so ordering by it is a total tie that
    // reshuffles arbitrarily (Design Review M1). Tasks without a stored score
    // sort last, honestly, rather than pretending a priority.
    const filterActive = statusFilter !== "all";
    const headCount = () =>
      supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId)
        .eq("plan_id", plan.id);
    let tasksQuery = supabase
      .from("tasks")
      .select("id, module, automation_level, status, payload")
      .eq("client_id", clientId)
      .eq("plan_id", plan.id);
    if (filterActive) tasksQuery = tasksQuery.eq("status", statusFilter);

    const [tasksRes, totalAllRes, totalFilteredRes] = await Promise.all([
      tasksQuery
        .order("payload->priorityScore", { ascending: false, nullsFirst: false })
        .order("id", { ascending: true })
        .limit(TASK_LIMIT),
      headCount(),
      filterActive ? headCount().eq("status", statusFilter) : Promise.resolve(null),
    ]);

    if (
      tasksRes.error ||
      !tasksRes.data ||
      Boolean(totalAllRes.error) ||
      totalAllRes.count === null
    ) {
      return { ok: false };
    }
    if (
      filterActive &&
      (totalFilteredRes === null ||
        totalFilteredRes.error ||
        totalFilteredRes.count === null)
    ) {
      return { ok: false };
    }

    const tasks: TaskEntry[] = (
      tasksRes.data as Array<{
        id: string;
        module: string;
        automation_level: AutomationLevel;
        status: TaskStatus;
        payload: unknown;
      }>
    ).map((r) => ({
      id: r.id,
      module: r.module,
      automationLevel: r.automation_level,
      status: r.status,
      detail: readTaskDetail(r.payload),
    }));

    const totalAll = totalAllRes.count ?? 0;

    return {
      ok: true,
      data: {
        version: plan.playbook_version,
        createdAt: plan.created_at,
        planCount,
        vertical,
        hasPlan: true,
        totalAll,
        totalFiltered: filterActive ? (totalFilteredRes!.count ?? 0) : totalAll,
        tasks,
      },
    };
  } catch {
    return { ok: false };
  }
}

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export default async function PlanTab({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { clientId } = await params;
  const statusFilter = parseStatusFilter(await searchParams);
  const [result, claims] = await Promise.all([
    load(clientId, statusFilter),
    getClaims(),
  ]);

  // Role gates. `canManage` mirrors tasks_update's writer floor (staff); the
  // Generate control mirrors the dashboard card's admin-only variant. Null claim
  // (env-less build / no membership) fails closed to no controls.
  const role: JwtRole | null = claims?.role ?? null;
  const canManage = role ? isStaffRole(role) : false;

  // Reuse the dashboard's exact decision: the Generate-plan control appears only
  // when the client actually needs generation (agency_admin, live vertical,
  // plan-less or zero-task residue). A healthy plan shows no control — the
  // idempotent action can't rebuild one, so a button would be a no-op lie. Note
  // "generate" structurally implies totalAll === 0, so the control's only home
  // is the roadmap empty state below (Design Review M3).
  const planVariant = result.ok
    ? planRowVariant({
        role,
        vertical: result.data.vertical ?? "",
        hasPlan: result.data.hasPlan,
        taskCount: result.data.totalAll,
      })
    : "none";

  const base = `/clients/${clientId}/plan`;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        level="h2"
        title="Plan"
        description="The playbook-driven roadmap — prioritized tasks, each with how much a human stays in the loop, and where you own the work, a control to move it."
      />

      {/* Persistent live region for the controls' successes — mounted once at a
          stable position so router.refresh() preserves it while the announcing
          control unmounts (see _components/announcer.tsx). */}
      <PlanAnnouncer />

      {!result.ok ? (
        <PanelCard
          title="Roadmap"
          description="Tasks generated from the client's playbook and audit"
        >
          <FailedState subject="the plan" />
        </PanelCard>
      ) : result.data.totalAll === 0 ? (
        <PanelCard
          title="Roadmap"
          description="Tasks generated from the client's playbook and audit"
          aside={
            result.data.version ? (
              <StatusPill tone="accent">Playbook {result.data.version}</StatusPill>
            ) : undefined
          }
        >
          <RoadmapEmpty
            clientId={clientId}
            showGenerate={planVariant === "generate"}
            vertical={result.data.vertical}
          />
        </PanelCard>
      ) : (
        <>
          <StatusFilterBar base={base} status={statusFilter} />

          <PanelCard
            title="Roadmap"
            description="Tasks generated from the client's playbook and audit"
            aside={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <StatusPill tone="muted">
                  {countLabel(result.data.totalFiltered, statusFilter !== "all")}
                </StatusPill>
                {result.data.version ? (
                  <StatusPill tone="accent">
                    Playbook {result.data.version}
                  </StatusPill>
                ) : null}
              </div>
            }
          >
            {result.data.tasks.length === 0 ? (
              statusFilter === "all" ? (
                // No filter, a positive task count, but zero rows: the list read
                // raced/failed against the count — say that truthfully, never
                // "no tasks match" (Design Review m1 / CR minor 1).
                <EmptyState
                  icon={ClipboardListIcon}
                  title="The tasks didn’t load"
                  description="This plan has tasks, but the list came back empty just now. Refresh to reload the roadmap."
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href={base}>Refresh</Link>
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  icon={FilterXIcon}
                  title="No tasks match this filter"
                  description={`This plan has nothing in “${STATUS_LABEL[statusFilter]}” right now. Clear the filter to see the whole roadmap.`}
                  action={
                    <Button asChild size="sm" variant="outline">
                      <Link href={base}>Clear filter</Link>
                    </Button>
                  }
                />
              )
            ) : (
              <ul className="flex flex-col gap-3">
                {result.data.tasks.map((task) => (
                  <TaskCard key={task.id} task={task} canManage={canManage} />
                ))}
              </ul>
            )}
          </PanelCard>

          {result.data.tasks.length === TASK_LIMIT &&
          result.data.totalFiltered > TASK_LIMIT ? (
            <p className="text-xs text-muted">
              Showing the first {TASK_LIMIT} of {result.data.totalFiltered} —
              highest priority first.
            </p>
          ) : null}

          {result.data.planCount > 1 ? (
            <p className="text-xs leading-5 text-muted">
              This client has {result.data.planCount} plan versions — you’re
              looking at the most recent.
            </p>
          ) : null}

          {result.data.createdAt ? (
            <p className="text-xs leading-5 text-muted">
              Plan generated {DATE_MED.format(Date.parse(result.data.createdAt))}.
              Plans regenerate only when a client has no working roadmap — a plan
              that already has tasks is never rebuilt from here.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Aside count label — honest about whether it's the filtered subset or the whole plan. */
function countLabel(n: number, filtered: boolean): string {
  const noun = n === 1 ? "task" : "tasks";
  return filtered ? `${n} matching` : `${n} ${noun}`;
}

/* ------------------------------------------------------------------ */
/* Zero-task state (Design Review M3)                                  */
/* ------------------------------------------------------------------ */

/**
 * The honest zero-task state — an EmptyState (this is a roadmap, not a metric,
 * so no "measuring soon" vocabulary), with the inviting first action exactly
 * where it can be acted on:
 *  - the caller can generate (agency_admin, live vertical) → the Generate-plan
 *    control IS the empty state's action;
 *  - dormant vertical → the approved "activates once this vertical's playbook
 *    ships" line, no control (a button can't hurry a dormant playbook);
 *  - anyone else → a plain statement of how the roadmap arrives, with NO invite
 *    to a control they don't have.
 */
function RoadmapEmpty({
  clientId,
  showGenerate,
  vertical,
}: {
  clientId: string;
  showGenerate: boolean;
  vertical: string | null;
}) {
  if (showGenerate) {
    return (
      <EmptyState
        icon={ClipboardListIcon}
        title="No tasks yet"
        description="This client doesn’t have a working roadmap yet. Generate the plan and the playbook’s prioritized tasks land right here."
        action={<RegeneratePlanButton clientId={clientId} />}
      />
    );
  }
  if (vertical !== null && !isLiveVertical(vertical)) {
    return (
      <EmptyState
        icon={ClipboardListIcon}
        title="No tasks yet"
        description="No active playbook for this industry yet, so there’s no plan to build. A plan activates once this vertical’s playbook ships."
      />
    );
  }
  return (
    <EmptyState
      icon={ClipboardListIcon}
      title="No tasks yet"
      description="The roadmap lands here once this client’s plan is generated — generating plans is an agency-admin action."
    />
  );
}

/* ------------------------------------------------------------------ */
/* Status filter (server-rendered GET form — no client JS)             */
/* ------------------------------------------------------------------ */

// `border-input` matches the system form controls (Input/Textarea).
const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm text-ink outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function StatusFilterBar({
  base,
  status,
}: {
  base: string;
  status: TaskStatus | "all";
}) {
  return (
    <form method="get" action={base} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        Status
        <select name="status" defaultValue={status} className={SELECT_CLASS}>
          <option value="all">Any status</option>
          {STATUS_FILTER_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" size="sm" variant="outline">
        Apply filter
      </Button>
      {status !== "all" ? (
        <Link
          href={base}
          className="text-sm text-muted underline-offset-4 hover:text-ink hover:underline"
        >
          Clear
        </Link>
      ) : null}
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Task card                                                           */
/* ------------------------------------------------------------------ */

function TaskCard({
  task,
  canManage,
}: {
  task: TaskEntry;
  canManage: boolean;
}) {
  const { detail } = task;
  const impact = detail.impact ? IMPACT_META[detail.impact] : null;
  const moduleLabel = MODULE_LABEL[task.module] ?? null;
  const headline = detail.title ?? moduleLabel ?? "Plan task";

  // The legal manual actions the SERVER vouches for — the task-status edge
  // table (0013): human_only todo ⇄ in_progress ⇄ done; ai_draft_human_approve
  // todo ⇄ in_progress work-tracking only; auto none. The control only shows
  // when the caller can actually run the action.
  const actions: ManualAction[] = canManage
    ? manualActionsFor(task.automationLevel, task.status)
    : [];
  // Rendered in the detail for EVERY task — including alongside the control
  // (Design Review M2: the completion gap is disclosed, not hidden by having a
  // start/stop control).
  const note = statusNote(task.automationLevel);

  // Meta chips — only fields the payload actually carries (absent ≠ zero).
  const meta: string[] = [];
  if (moduleLabel) meta.push(moduleLabel);
  if (detail.channel) meta.push(capitalize(detail.channel));
  if (detail.effortWeight !== null) meta.push(`Effort ${detail.effortWeight}/5`);
  if (detail.source) meta.push(SOURCE_LABEL[detail.source]);

  return (
    <li className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-raised px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        {impact ? <StatusPill tone={impact.tone}>{impact.label}</StatusPill> : null}
        <StatusPill tone={STATUS_TONE[task.status]}>
          {STATUS_LABEL[task.status]}
        </StatusPill>
        <span className="min-w-0 text-sm font-medium text-ink">{headline}</span>
        <span className="ml-auto shrink-0 text-xs text-muted">
          {AUTOMATION_LABEL[task.automationLevel]}
        </span>
      </div>

      {meta.length > 0 ? (
        <p className="font-mono text-[11px] leading-5 tracking-wide text-muted">
          {meta.join("  ·  ")}
        </p>
      ) : null}

      {actions.length > 0 ? (
        <TaskStatusControl taskId={task.id} actions={actions} />
      ) : null}

      <details className="group">
        <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded text-xs font-medium text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60">
          <span className="group-open:hidden">Task detail</span>
          <span className="hidden group-open:inline">Hide detail</span>
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          {detail.description ? (
            <p className="text-[13px] leading-5 text-muted">
              {detail.description}
            </p>
          ) : (
            <p className="text-[13px] leading-5 text-muted">
              This task carries no stored description.
            </p>
          )}
          <p className="text-xs leading-5 text-muted">{note}</p>
        </div>
      </details>
    </li>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
