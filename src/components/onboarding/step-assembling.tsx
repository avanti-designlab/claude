"use client";

/**
 * Step 4 — "your custom plan is assembling" (doc 06 §5, animated moment #1).
 *
 * The assembling beat now covers the REAL server write: the flow fires
 * `createClientFromOnboarding` on entry, and the beat resolves only when both
 * the animation timer AND the server action have finished (`shouldReveal`) —
 * holding on the assembling panel if the write outlasts the timer. What
 * reveals is the SERVER-PERSISTED plan (the action's returned roadmap), via
 * OnboardingPlanReveal (the sanctioned moment). Under reduced motion the
 * timer is skipped — the panel waits statically, then the final state renders
 * instantly. A failed save renders the server's interface-voice error with a
 * retry; Back (in the flow footer) reopens too — the retry replays the same
 * idempotency key, so even a save that silently landed is recovered (and
 * reconciled to any edits), never duplicated.
 */

import * as React from "react";
import { CheckIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OnboardingPlanReveal, useReducedMotion } from "@/components/moments";
import { cn } from "@/lib/theme/utils";
import { IMPACT_LABEL } from "./onboarding-copy";
import {
  planOutcome,
  SAVE_ERROR_HEADING,
  saveErrorBody,
  shouldReveal,
  type SaveState,
} from "./save-outcome";

export interface StepAssemblingProps {
  /** The in-flight / settled server write (client + plan persistence). */
  save: SaveState;
  /** Advance to the full plan. */
  onContinue: () => void;
  /**
   * Re-fire the save after an error. Same idempotency key every attempt: a
   * lost-response save that actually landed is recovered, not duplicated.
   */
  onRetry: () => void;
}

const ASSEMBLING_STEPS = [
  "Reading your industry playbook",
  "Weighing channels by where authority is built",
  "Prioritizing tasks by impact",
];

function AssemblingPanel({ reduced }: { reduced: boolean }) {
  return (
    <div className="flex flex-col items-center gap-6 rounded-xl border bg-card px-6 py-12 text-center">
      <span className="relative flex size-14 items-center justify-center">
        {/* The pulse rides the reduced-motion gate — a static dot when reduced
            (this panel can now show under reduced motion while the server
            write is still in flight). */}
        {reduced ? null : (
          <span className="absolute inset-0 animate-ping rounded-full bg-accent/25" />
        )}
        <span className="relative size-3 rounded-full bg-accent" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-2xl text-ink">
          Assembling your plan
        </h2>
        <p className="text-sm text-muted">
          Turning your industry playbook into a prioritized, channel-weighted
          roadmap — and saving it to your workspace.
        </p>
      </div>
      <ul className="flex flex-col gap-2 text-sm text-muted">
        {ASSEMBLING_STEPS.map((label) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                "size-1.5 rounded-full bg-accent",
                !reduced && "animate-pulse"
              )}
            />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SaveErrorPanel({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  // Heading + dedupe live in save-outcome.ts (pure, unit-tested): server
  // strings opening with the heading sentence are trimmed; everything else —
  // including the client-side SAVE_UNREACHABLE fallback — renders verbatim.
  const body = saveErrorBody(message);
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-6 rounded-xl border border-negative/40 bg-negative/5 px-6 py-12 text-center"
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-overlay">
        <XIcon aria-hidden className="size-5 text-negative" />
      </span>
      <div className="flex max-w-md flex-col gap-1">
        <h2 className="font-display text-2xl text-ink">
          {SAVE_ERROR_HEADING}
        </h2>
        {/* The server action's error is already interface voice (what
            happened + what to do) — render it with the heading sentence
            deduped above. */}
        <p className="text-sm text-muted">{body}</p>
      </div>
      <Button type="button" onClick={onRetry}>
        <RotateCcwIcon aria-hidden /> Try again
      </Button>
    </div>
  );
}

export function StepAssembling({
  save,
  onContinue,
  onRetry,
}: StepAssemblingProps) {
  const reduced = useReducedMotion();
  const [timerDone, setTimerDone] = React.useState(false);

  React.useEffect(() => {
    if (reduced) return;
    const timer = setTimeout(() => setTimerDone(true), 1600);
    return () => clearTimeout(timer);
  }, [reduced]);

  // Derived (not synced in an effect) to avoid cascading renders: the beat
  // resolves when the timer (skipped under reduced motion) AND the server
  // write have both finished — the animation covers the real await.
  const revealed = shouldReveal(reduced, timerDone, save);

  if (!revealed) {
    return <AssemblingPanel reduced={reduced} />;
  }

  if (save.phase === "error") {
    return <SaveErrorPanel message={save.message} onRetry={onRetry} />;
  }
  if (save.phase !== "saved") {
    // Unreachable in the flow (the save fires before step 4 mounts); hold the
    // assembling panel rather than reveal something that doesn't exist.
    return <AssemblingPanel reduced={reduced} />;
  }

  const outcome = planOutcome(save.plan, save.planWarning);
  const persistedTasks = save.plan?.roadmap.tasks ?? [];
  const hasTasks = persistedTasks.length > 0;

  const revealTasks = persistedTasks.slice(0, 6).map((task) => ({
    title: task.title,
    channel: task.channel,
    meta: IMPACT_LABEL[task.impact],
  }));

  return (
    <div className="flex flex-col gap-8">
      {hasTasks ? (
        <OnboardingPlanReveal
          heading="Your plan is ready"
          subheading="Saved to your workspace, straight from your industry playbook — audit findings fold in once your properties connect. Here are the first moves."
          tasks={revealTasks}
        />
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed px-6 py-12 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-overlay">
            <CheckIcon aria-hidden className="size-5 text-accent" />
          </span>
          <div className="flex max-w-md flex-col gap-1">
            <h2 className="font-display text-2xl text-ink">
              {save.client.name} is saved
            </h2>
            <p className="text-sm text-muted">
              {outcome === "plan-write-failed"
                ? save.planWarning
                : outcome === "no-playbook"
                  ? "No playbook for this industry yet — a plan activates the moment this vertical's playbook ships."
                  : "Your plan is saved. Tasks land on your dashboard as your playbook and audit surface them."}
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
