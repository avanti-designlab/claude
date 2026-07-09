"use client";

/**
 * Step 5 — the custom AEO/GEO/local plan (doc 06 §5). Renders the
 * SERVER-PERSISTED result of `createClientFromOnboarding` — the roadmap shown
 * is `plan.roadmap` exactly as saved, never a client-side regeneration, so
 * what the operator sees is what the database holds. Three outcomes:
 *
 *  - plan persisted            → "Saved — N tasks created" + the full roadmap
 *                                (channel-weighted effort split, prioritized
 *                                task list with module + automation-level
 *                                badges and effort weighting, plan summary).
 *  - no active playbook (null) → the client saved; a plan activates when this
 *                                vertical's playbook ships. Nothing failed.
 *  - plan write failed (null + planWarning) → the client saved; the server's
 *                                interface-voice warning, rendered calmly.
 */

import Link from "next/link";
import { CalendarCheckIcon, CheckCircle2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ShareOfVoice, type ShareOfVoiceEntry } from "@/components/charts";
import { APP_HOME } from "@/components/app-shell/nav";
import type { CreatedClient, CreatedPlan } from "@/lib/clients/actions";
import type { RoadmapTask } from "@/lib/types/roadmap";
import { cn } from "@/lib/theme/utils";
import {
  AUTOMATION_META,
  IMPACT_BADGE_VARIANT,
  IMPACT_LABEL,
  MODULE_LABEL,
} from "./onboarding-copy";
import { planOutcome } from "./save-outcome";

export interface StepPlanProps {
  /** The persisted client (the save happened during the assembling step). */
  client: CreatedClient;
  /** The persisted plan, or null (no active playbook / plan write failed). */
  plan: CreatedPlan | null;
  /** Present iff the client saved but the plan write path failed. */
  planWarning?: string;
  verticalLabel: string;
}

function EffortMeter({ weight }: { weight: number }) {
  const clamped = Math.max(0, Math.min(5, Math.round(weight)));
  return (
    <span
      className="inline-flex items-center gap-1"
      aria-label={`Effort ${clamped} of 5`}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            i < clamped ? "bg-accent" : "bg-overlay"
          )}
        />
      ))}
    </span>
  );
}

function TaskCard({ task, index }: { task: RoadmapTask; index: number }) {
  const automation = AUTOMATION_META[task.automationLevel];
  return (
    <li className="flex gap-4 rounded-xl border bg-card p-4">
      <span className="font-mono text-xs text-muted tabular-nums">
        {String(index + 1).padStart(2, "0")}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-col gap-1">
          <span className="font-medium text-ink">{task.title}</span>
          <span className="text-sm text-muted">{task.description}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{MODULE_LABEL[task.module]}</Badge>
          <Badge variant="outline" className="font-mono text-[10px] uppercase">
            {task.channel}
          </Badge>
          <Badge variant={IMPACT_BADGE_VARIANT[task.impact]}>
            {IMPACT_LABEL[task.impact]}
          </Badge>
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="ghost" className="cursor-help text-muted">
                {automation.label}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{automation.hint}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="font-mono text-[10px] tracking-wide text-muted uppercase">
          Effort
        </span>
        <EffortMeter weight={task.effortWeight} />
      </div>
    </li>
  );
}

function ChannelAllocation({
  allocation,
}: {
  allocation: Record<string, number>;
}) {
  const entries = Object.entries(allocation)
    .map(([name, share]) => ({ name, share: Math.round(share * 100) }))
    .sort((a, b) => b.share - a.share);

  if (entries.length === 0) return null;

  const topShare = entries[0].share;
  const data: ShareOfVoiceEntry[] = entries.map((entry) => ({
    name: entry.name,
    share: entry.share,
    // The lead channel wears the tenant accent; the rest recede.
    isClient: entry.share === topShare,
  }));

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      <div className="flex flex-col gap-0.5">
        <h3 className="font-medium text-ink">Where your effort goes</h3>
        <p className="text-sm text-muted">
          Weighted by your playbook — never split evenly.
        </p>
      </div>
      <ShareOfVoice data={data} height={Math.max(120, data.length * 40)} />
    </div>
  );
}

/**
 * The "Saved — N tasks created" confirmation strip (the save happened during
 * the assembling step; this is its receipt, in the panel language the old
 * save panel used: positive border/tint + check).
 */
function SavedConfirmation({
  client,
  taskCount,
}: {
  client: CreatedClient;
  taskCount: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-positive/40 bg-positive/5 p-4">
      <CheckCircle2Icon aria-hidden className="size-5 shrink-0 text-positive" />
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="font-medium text-ink">
          Saved — {taskCount} {taskCount === 1 ? "task" : "tasks"} created
        </p>
        <p className="text-sm text-muted">
          <span className="font-medium text-ink">{client.name}</span> is in
          your workspace with this plan on the board.
        </p>
      </div>
      {/* Literal /clients (not APP_HOME): the label promises the clients
          list, and APP_HOME lands on the dashboard. */}
      <Button asChild size="sm" variant="outline">
        <Link href="/clients">View clients</Link>
      </Button>
    </div>
  );
}

/** Plan-less outcomes: client saved, no roadmap to show — say exactly why. */
function PlanlessState({
  client,
  planWarning,
}: {
  client: CreatedClient;
  planWarning?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-overlay">
        <CalendarCheckIcon aria-hidden className="size-5 text-accent" />
      </span>
      <div className="flex max-w-md flex-col gap-1">
        <h2 className="font-display text-2xl text-ink">
          {planWarning
            ? `${client.name} is saved`
            : "No playbook for this industry yet"}
        </h2>
        <p className="text-sm text-muted">
          {planWarning ??
            `${client.name} is saved to your workspace. A plan activates once this vertical's playbook ships — your prioritized, channel-weighted roadmap lands here the moment it opens.`}
        </p>
      </div>
      {planWarning ? (
        // Plan-write-failed: the CTA points at the FIX — the dashboard's
        // Generate-plan control lives on this client's card (design review,
        // 2026-07-09, Major 2). APP_HOME is the dashboard.
        <Button asChild size="sm" variant="outline">
          <Link href={APP_HOME}>Go to your dashboard</Link>
        </Button>
      ) : (
        // No-playbook: nothing to fix — the clients list is the destination.
        <Button asChild size="sm" variant="outline">
          <Link href="/clients">View clients</Link>
        </Button>
      )}
    </div>
  );
}

export function StepPlan({
  client,
  plan,
  planWarning,
  verticalLabel,
}: StepPlanProps) {
  const outcome = planOutcome(plan, planWarning);

  if (outcome !== "plan" || plan === null) {
    return <PlanlessState client={client} planWarning={planWarning} />;
  }

  const { roadmap } = plan;
  const generatedDate = new Date(roadmap.generatedAt);
  const generatedLabel = Number.isNaN(generatedDate.getTime())
    ? roadmap.generatedAt
    : generatedDate.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });

  return (
    <div className="flex flex-col gap-6">
      <SavedConfirmation client={client} taskCount={plan.taskCount} />

      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{verticalLabel}</Badge>
          <span className="font-mono text-[10px] tracking-wide text-muted uppercase">
            Playbook v{roadmap.playbookVersion} · {generatedLabel}
          </span>
        </div>
        <h2 className="font-display text-2xl text-ink">Your custom plan</h2>
        {roadmap.summary ? (
          <p className="max-w-2xl text-sm text-muted">{roadmap.summary}</p>
        ) : null}
      </header>

      <ChannelAllocation allocation={roadmap.channelAllocation} />

      {roadmap.tasks.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="font-medium text-ink">
              Prioritized tasks
            </h3>
            <span className="font-mono text-xs text-muted">
              {roadmap.tasks.length} in order
            </span>
          </div>
          <Separator />
          <ol className="flex flex-col gap-3">
            {roadmap.tasks.map((task, index) => (
              <TaskCard key={task.id} task={task} index={index} />
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
