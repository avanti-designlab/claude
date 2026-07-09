"use client";

/**
 * The card-level "Generate plan" control (carried ticket a, part 2 — the
 * recovery UI for `regeneratePlanForClient`). Rendered by the dashboard's
 * client cards ONLY for a plan-less client in a LIVE vertical
 * (isLiveVertical); dormant verticals keep the quiet "None yet" row.
 *
 * Deliberately utilitarian — an xs outline button inside the card's Plan
 * row, no glow, no animation. On success (fresh plan OR one that already
 * existed) the router refreshes and the live numbers speak for themselves;
 * on failure the server's interface-voice error renders verbatim under the
 * control and the button stays armed — the action is idempotent, so a retry
 * can never duplicate a plan.
 *
 * Renders the whole dt/dd group so it slots into the card's <dl> as valid
 * markup (the error paragraph lives inside the <dd>).
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
        // Both ok variants land here (alreadyExisted included): re-run the
        // page's queries inside the transition so the plan and its task
        // numbers appear, and the button stays pending until they do.
        router.refresh();
        return;
      }
      setError(outcome.message);
    });
  };

  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted">Plan</dt>
      <dd className="flex min-w-0 flex-col items-end gap-1.5">
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={generate}
          disabled={pending}
        >
          {pending ? "Generating…" : "Generate plan"}
        </Button>
        {error ? (
          <p
            role="alert"
            className="text-right text-[11px] leading-4 text-negative"
          >
            {error}
          </p>
        ) : null}
      </dd>
    </div>
  );
}
