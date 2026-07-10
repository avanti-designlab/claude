"use client";

/**
 * The per-row manual status control (P1 slice + the 0013 extension). Shown ONLY
 * on tasks the human owns a move for — the server passes the legal actions it
 * computed via `manualActionsFor` (one edge table in task-status.ts: human_only
 * gets todo ⇄ in_progress ⇄ done, ai_draft_human_approve gets todo ⇄ in_progress
 * work-tracking only, auto gets nothing), so this island never invents a move:
 * an empty `actions` array renders nothing.
 *
 * Every button calls the ONE sanctioned action (`updateTaskStatus`) verbatim,
 * which re-enforces the writer floor, the per-target automation-level set, and
 * the CAS source(s) at the database — this is an honest UX mirror of that floor,
 * never the security boundary. One shared transition + an explicit re-entry
 * guard blocks double-submit; while a submit is in flight ONLY the clicked
 * button's label swaps to "Working…" (a card can carry TWO buttons — "Mark done"
 * + "Move back" — and swapping both reads as a duplicated-button glitch); the
 * sibling is merely disabled. Failures render the action's interface-voice error
 * verbatim; successes announce through the persistent PlanAnnouncer and
 * router-refresh so the row's new status pill + newly-legal actions are visible
 * immediately.
 *
 * CARRIED PATTERN (design review m2, recorded app-wide): while a submit is
 * pending these buttons are `disabled`, and browsers evict focus from disabled
 * elements — keyboard focus can drop to <body> mid-action (and on success the
 * acting button is replaced by the flipped edge's button). The same mechanics
 * are documented at the review queue's decision panel; the shared fix is
 * tracked centrally, not patched per control.
 */

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { NEGATIVE_TEXT_CLASS } from "@/components/tone";
import type { ManualAction } from "@/lib/plans/task-status";
import { updateTaskStatus } from "@/lib/plans/update-status";
import { announcePlan } from "./announcer";

const UNREACHABLE_ERROR =
  "We couldn’t reach the server to update this task. Check your connection and try again.";

export function TaskStatusControl({
  taskId,
  actions,
}: {
  taskId: string;
  actions: ManualAction[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  // WHICH action is in flight — so only the clicked button reads "Working…"
  // (design mA: a two-button card swapping BOTH labels looked like a duplicated
  // button). Meaningful only while `pending`; stale values are inert.
  const [inFlight, setInFlight] = React.useState<ManualAction["to"] | null>(null);

  const run = (action: ManualAction) => {
    // The double-submit invariant is LOCAL — an explicit guard, not a reliance
    // on React's disabled-flush timing.
    if (pending) return;
    setError(null);
    setInFlight(action.to);
    startTransition(async () => {
      let ok = false;
      let message: string | null = null;
      try {
        const res = await updateTaskStatus({ taskId, to: action.to });
        ok = res.ok;
        if (!res.ok) message = res.error;
      } catch {
        message = UNREACHABLE_ERROR;
      }
      if (ok) {
        // Announce before the refresh: the row re-renders with a new status and
        // new legal actions, and the persistent live region carries the word.
        announcePlan(action.done);
        router.refresh();
        return;
      }
      setError(message);
    });
  };

  if (actions.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((action) => (
          <Button
            key={action.to}
            type="button"
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => run(action)}
          >
            {pending && inFlight === action.to ? "Working…" : action.label}
          </Button>
        ))}
      </div>
      {error ? (
        <p role="alert" className={`text-[11px] leading-4 ${NEGATIVE_TEXT_CLASS}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
