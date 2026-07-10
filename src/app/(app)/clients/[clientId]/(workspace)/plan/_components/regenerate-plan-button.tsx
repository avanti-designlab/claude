"use client";

/**
 * The in-workspace Generate-plan control (P1 slice) — brings the recovery action
 * that previously lived only on the global dashboard next to the work, per the
 * UX audit ("wrong distance from the work"). Placement (Design Review M3): the
 * roadmap EMPTY STATE's action slot — the inviting first-action moment. The
 * "generate" variant structurally implies zero tasks (planRowVariant returns it
 * only when no healthy plan exists), so the empty state is the only place this
 * control can ever be needed; it never coexists with a task list.
 *
 * SEMANTICS ARE NOT FORKED: this reuses the EXACT frozen action
 * (`regeneratePlanForClient`, agency_admin-only, idempotent) and the dashboard's
 * pure outcome mapper (`toGeneratePlanOutcome` / `GENERATE_UNREACHABLE`). It does
 * NOT reuse the dashboard's `GeneratePlanRow` component verbatim, only because
 * that renders a card-specific <dt>/<dd> row and announces into the DASHBOARD's
 * live region — neither fits an empty-state action slot. The behaviour it
 * carries (which result refreshes, which error shows, that a retry can never
 * duplicate a plan) is identical.
 *
 * ROLE GATE: rendered by the server ONLY when planRowVariant(...) === "generate"
 * (agency_admin, live vertical, a client that needs generation) — the same gate
 * the dashboard card uses; the action re-checks agency_admin server-side anyway.
 * On success the router refreshes (the plan + its tasks appear) and "Plan
 * generated" is announced through the persistent PlanAnnouncer, which outlives
 * this button's unmount. On failure the server's interface-voice error renders
 * verbatim and the button stays armed (idempotent — a retry can't duplicate).
 *
 * CARRIED PATTERN (design review m2, recorded app-wide): while the action is
 * pending this button is `disabled`, and browsers evict focus from disabled
 * elements — keyboard focus can drop to <body> mid-action. The same mechanics
 * are documented at the review queue's decision panel; the shared fix is
 * tracked centrally, not patched per control.
 */

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { NEGATIVE_TEXT_CLASS } from "@/components/tone";
import { regeneratePlanForClient } from "@/lib/plans/actions";
import {
  GENERATE_UNREACHABLE,
  type GeneratePlanOutcome,
  toGeneratePlanOutcome,
} from "../../../../../dashboard/generate-plan-outcome";
import { announcePlan } from "./announcer";

export function RegeneratePlanButton({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const generate = () => {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      let outcome: GeneratePlanOutcome;
      try {
        outcome = toGeneratePlanOutcome(
          await regeneratePlanForClient({ clientId })
        );
      } catch {
        outcome = { kind: "error", message: GENERATE_UNREACHABLE };
      }
      if (outcome.kind === "refresh") {
        // Announce BEFORE the refresh swaps this button for the roadmap — the
        // persistent live region outlives the unmount.
        announcePlan("Plan generated");
        router.refresh();
        return;
      }
      setError(outcome.message);
    });
  };

  // Centered — this control lives in the empty state's action slot.
  return (
    <div className="flex flex-col items-center gap-1.5">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={generate}
        disabled={pending}
      >
        {pending ? "Generating…" : "Generate plan"}
      </Button>
      {error ? (
        <p
          role="alert"
          className={`max-w-xs text-center text-[11px] leading-4 ${NEGATIVE_TEXT_CLASS}`}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
