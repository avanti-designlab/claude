"use client";

/**
 * The per-row "Acknowledge" control on the open-alerts feed — the utilitarian
 * operator affordance that closes the alerting loop (no glow, no animation, doc
 * 06 §4/§5). Calls the sole sanctioned `acknowledgeAlert` action; on success the
 * router refreshes and the row leaves the open feed honestly (the count and the
 * top-bar badge both re-read). The button is disabled while pending, so a
 * double-press can't fire a second write.
 *
 * An `already_acknowledged` outcome is treated as a soft success — the alert IS
 * acknowledged (someone beat us to it, or the view was stale), so refreshing to
 * drop the row reflects reality rather than showing a scary error. Only a real
 * failure (forbidden / not_found / acknowledge_failed) surfaces the server's
 * interface-voice message inline, with the button left armed for a safe retry.
 *
 * There is NO un-acknowledge here by design: acknowledge is one-way (re-opening
 * would corrupt M5's fingerprint dedup). The acknowledged view is the recovery.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { acknowledgeAlert } from "@/lib/alerting/acknowledge";
import { NEGATIVE_TEXT_CLASS } from "../../../_components/tone";

const UNREACHABLE_ERROR =
  "We couldn’t reach the server to acknowledge this alert. Check your connection and try again.";

export function AcknowledgeButton({
  alertId,
  label,
}: {
  alertId: string;
  /** Accessible context so the control isn't a bare "Acknowledge" to a screen reader. */
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const acknowledge = () => {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof acknowledgeAlert>>;
      try {
        result = await acknowledgeAlert({ alertId });
      } catch {
        setError(UNREACHABLE_ERROR);
        return;
      }
      // ok AND already_acknowledged both mean "it's acknowledged now" — refresh
      // so the row drops out of the open feed. Only real failures stay on screen.
      if (result.ok || result.reason === "already_acknowledged") {
        router.refresh();
        return;
      }
      setError(result.error);
    });
  };

  // One control, two renderings (Design Review Major 2): below `sm` the row is
  // tight beside the severity pill, so the button collapses to the icon-only
  // `icon-sm` variant — fixed width, no "Acknowledge"→"Acknowledging…" jump —
  // with the aria-label carrying the full context. From `sm` up the labeled xs
  // button renders instead. Exactly one is ever in the accessibility tree
  // (`hidden` is display:none); both share the same handler + pending state.
  const shared = {
    type: "button" as const,
    variant: "outline" as const,
    onClick: acknowledge,
    disabled: pending,
    "aria-label": `Acknowledge: ${label}`,
  };

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button {...shared} size="icon-sm" className="sm:hidden">
        <CheckIcon aria-hidden />
      </Button>
      <Button {...shared} size="xs" className="hidden sm:inline-flex">
        <CheckIcon aria-hidden />
        {pending ? "Acknowledging…" : "Acknowledge"}
      </Button>
      {error ? (
        <p role="alert" className={`max-w-[16rem] text-right text-[11px] leading-4 ${NEGATIVE_TEXT_CLASS}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
