"use client";

/**
 * The card-level "Generate plan" control (carried ticket a, part 2 — the
 * recovery UI for `regeneratePlanForClient`). Rendered by the dashboard's
 * client cards per `planRowVariant`: an agency_admin caller (the only role
 * the action accepts), a LIVE vertical, and a client that needs generation —
 * plan-less OR carrying a zero-task residue plan (the tolerated
 * partial-failure state; the action's supersede path is idempotent and
 * handles it). Other roles and dormant verticals keep the quiet rows.
 *
 * Deliberately utilitarian — an xs outline button inside the card's Plan
 * row, no glow, no animation. On success (fresh plan OR one that already
 * existed) the router refreshes and the live numbers speak for themselves,
 * with a polite "Plan generated" pushed through the page's persistent
 * StatusAnnouncer — the announcement outlives this row's unmount (the
 * refresh swaps the control for the plan's version row). On failure the
 * server's interface-voice error renders verbatim, full-width beneath the
 * row, and the button stays armed — the action is idempotent, so a retry can
 * never duplicate a plan.
 *
 * Renders the whole dt/dd group so it slots into the card's <dl> as valid
 * markup: the error is a SECOND dd for the same dt (spec-valid), spanning
 * the full row so long messages wrap flat instead of squeezing beside the
 * label (design review, 2026-07-09, Minor 5 + Polish 10).
 *
 * Error text color: `text-negative` alone is only 3:1-gated by the palette
 * policy; at 11px normal text WCAG AA needs 4.5:1, so light mode wears the
 * designer-approved ink-mix — measured >= 4.5:1 on both chrome layers of
 * both reachable palettes in error-text-contrast.test.ts.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { regeneratePlanForClient } from "@/lib/plans/actions";
import {
  GENERATE_UNREACHABLE,
  type GeneratePlanOutcome,
  toGeneratePlanOutcome,
} from "./generate-plan-outcome";
import { announceStatus } from "./status-announcer";
import { NEGATIVE_TEXT_CLASS } from "../_components/tone";

export function GeneratePlanRow({ clientId }: { clientId: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const generate = () => {
    setError(null);
    startTransition(async () => {
      let outcome: GeneratePlanOutcome;
      try {
        outcome = toGeneratePlanOutcome(
          await regeneratePlanForClient({ clientId })
        );
      } catch {
        // The call itself failed to round-trip — same interface-voice
        // posture as the onboarding flow's SAVE_UNREACHABLE fallback.
        outcome = { kind: "error", message: GENERATE_UNREACHABLE };
      }
      if (outcome.kind === "refresh") {
        // Both ok variants land here (alreadyExisted included). Announce
        // BEFORE refreshing: the refresh replaces this row with the plan's
        // version row, and the persistent live region outlives that swap.
        announceStatus("Plan generated");
        // Re-run the page's queries inside the transition so the plan and
        // its task numbers appear, and the button stays pending until they do.
        router.refresh();
        return;
      }
      setError(outcome.message);
    });
  };

  return (
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5">
      <dt className="text-muted">Plan</dt>
      <dd className="flex min-w-0 justify-end">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={generate}
          disabled={pending}
        >
          {pending ? "Generating…" : "Generate plan"}
        </Button>
      </dd>
      {error ? (
        <dd className="col-span-2 min-w-0">
          <p role="alert" className={`text-[11px] leading-4 ${NEGATIVE_TEXT_CLASS}`}>
            {error}
          </p>
        </dd>
      ) : null}
    </div>
  );
}
