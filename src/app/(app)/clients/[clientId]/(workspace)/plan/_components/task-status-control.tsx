"use client";

/**
 * The per-row manual status control (P1 slice). Shown ONLY on tasks the human
 * owns the status of — the server passes the legal actions it computed via
 * `manualActionsFor` (human_only + the todo⇄in_progress subset), so this island
 * never invents a move: an empty `actions` array renders nothing.
 *
 * Every button calls the ONE sanctioned action (`updateTaskStatus`) verbatim,
 * which re-enforces the writer floor, the human_only ownership, and the CAS
 * source at the database — this is an honest UX mirror of that floor, never the
 * security boundary. One shared transition + an explicit re-entry guard blocks
 * double-submit; failures render the action's interface-voice error verbatim;
 * successes announce through the persistent PlanAnnouncer and router-refresh so
 * the row's new status pill + newly-legal actions are visible immediately.
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

  const run = (action: ManualAction) => {
    // The double-submit invariant is LOCAL — an explicit guard, not a reliance
    // on React's disabled-flush timing.
    if (pending) return;
    setError(null);
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
            {pending ? "Working…" : action.label}
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
