"use client";

/**
 * Step 5 — the custom AEO/GEO/local plan (doc 06 §5). Renders the REAL
 * GeneratedRoadmap from the playbook engine: the channel-weighted effort split,
 * the prioritized task list with per-task module + automation-level badges and
 * effort weighting, and the plan summary. No mock data — an empty roadmap
 * (engine still landing, or a dormant vertical) renders a graceful state.
 */

import { CalendarCheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ShareOfVoice, type ShareOfVoiceEntry } from "@/components/charts";
import type { GeneratedRoadmap, RoadmapTask } from "@/lib/types/roadmap";
import { cn } from "@/lib/theme/utils";
import {
  AUTOMATION_META,
  IMPACT_BADGE_VARIANT,
  IMPACT_LABEL,
  MODULE_LABEL,
} from "./onboarding-copy";

export interface StepPlanProps {
  roadmap: GeneratedRoadmap | null;
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

function EmptyPlan({ verticalLabel }: { verticalLabel: string }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-overlay">
        <CalendarCheckIcon aria-hidden className="size-5 text-accent" />
      </span>
      <div className="flex max-w-md flex-col gap-1">
        <h2 className="font-display text-2xl text-ink">
          Your {verticalLabel.toLowerCase()} plan is on its way
        </h2>
        <p className="text-sm text-muted">
          The playbook engine is being switched on for this industry. Your
          prioritized, channel-weighted roadmap lands here — no placeholders, the
          real plan or nothing.
        </p>
      </div>
    </div>
  );
}

export function StepPlan({ roadmap, verticalLabel }: StepPlanProps) {
  if (roadmap === null || roadmap.tasks.length === 0) {
    return <EmptyPlan verticalLabel={verticalLabel} />;
  }

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
    </div>
  );
}
