"use client";

/**
 * Step 4 — "your custom plan is assembling" (doc 06 §5, animated moment #1).
 *
 * A brief assembling beat resolves into the plan reveal (OnboardingPlanReveal,
 * the sanctioned moment). Under reduced motion the assembling delay is skipped
 * and the plan renders immediately — the moment component itself also renders
 * its final state instantly.
 */

import * as React from "react";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OnboardingPlanReveal, useReducedMotion } from "@/components/moments";
import type { GeneratedRoadmap } from "@/lib/types/roadmap";
import { cn } from "@/lib/theme/utils";
import { IMPACT_LABEL } from "./onboarding-copy";

export interface StepAssemblingProps {
  roadmap: GeneratedRoadmap | null;
  /** Advance to the full plan. */
  onContinue: () => void;
  /** True while the vertical has no active playbook yet (dormant rollout). */
  isDormantVertical: boolean;
}

const ASSEMBLING_STEPS = [
  "Reading your industry playbook",
  "Weighing channels by where authority is built",
  "Prioritizing tasks by impact",
];

function AssemblingPanel() {
  return (
    <div className="flex flex-col items-center gap-6 rounded-xl border bg-card px-6 py-12 text-center">
      <span className="relative flex size-14 items-center justify-center">
        <span className="absolute inset-0 animate-ping rounded-full bg-accent/25" />
        <span className="relative size-3 rounded-full bg-accent" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl text-ink">
          Assembling your plan
        </h2>
        <p className="text-sm text-muted">
          Turning your industry playbook into a prioritized, channel-weighted
          roadmap.
        </p>
      </div>
      <ul className="flex flex-col gap-2 text-sm text-muted">
        {ASSEMBLING_STEPS.map((label) => (
          <li key={label} className="flex items-center gap-2">
            <span className="size-1.5 animate-pulse rounded-full bg-accent" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StepAssembling({
  roadmap,
  onContinue,
  isDormantVertical,
}: StepAssemblingProps) {
  const reduced = useReducedMotion();
  const [timerDone, setTimerDone] = React.useState(false);

  React.useEffect(() => {
    if (reduced) return;
    const timer = setTimeout(() => setTimerDone(true), 1600);
    return () => clearTimeout(timer);
  }, [reduced]);

  // Reduced motion skips the assembling beat entirely; otherwise the timer
  // resolves it. Derived (not synced in an effect) to avoid cascading renders.
  const revealed = reduced || timerDone;

  if (!revealed) {
    return <AssemblingPanel />;
  }

  const hasTasks = roadmap !== null && roadmap.tasks.length > 0;

  const revealTasks = hasTasks
    ? roadmap.tasks.slice(0, 6).map((task) => ({
        title: task.title,
        channel: task.channel,
        meta: IMPACT_LABEL[task.impact],
      }))
    : [];

  return (
    <div className="flex flex-col gap-8">
      {hasTasks ? (
        <OnboardingPlanReveal
          heading="Your plan is ready"
          subheading="Assembled from your industry playbook — audit findings fold in once your properties connect. Here are the first moves."
          tasks={revealTasks}
        />
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-overlay">
            <CheckIcon aria-hidden className="size-5 text-accent" />
          </span>
          <div className="flex max-w-md flex-col gap-1">
            <h2 className="font-display text-2xl text-ink">
              You&apos;re all set up
            </h2>
            <p className="text-sm text-muted">
              {isDormantVertical
                ? "This industry's playbook is loaded but not yet active — real estate is first while we prove the loop. We'll flag you the moment it opens."
                : "Your plan isn't ready yet — it will be waiting on your dashboard, and we'll flag you when it lands."}
            </p>
          </div>
        </div>
      )}

      <div className={cn("flex", hasTasks ? "justify-end" : "justify-center")}>
        <Button type="button" onClick={onContinue}>
          {hasTasks ? "See the full plan" : "Continue"}
        </Button>
      </div>
    </div>
  );
}
