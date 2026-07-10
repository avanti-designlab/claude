"use client";

/**
 * "Acknowledge all shown" — one bounded, honest sweep over the alert ids CURRENTLY
 * RENDERED in the open feed. It passes exactly those ids to `acknowledgeAlerts`,
 * which scopes the write to `.in('id', ids)` (never a blind tenant-wide UPDATE)
 * and CAS-flips only the still-open ones. If the feed is truncated at its cap,
 * this only clears the shown page — the truncation note already says more remain,
 * so the label ("Acknowledge all N") stays true to what it touches.
 *
 * Utilitarian: an xs outline button in the panel header, disabled while pending
 * (no double-submit), interface-voice error inline on failure, router.refresh()
 * on success so the feed and the top-bar badge re-read.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { acknowledgeAlerts } from "@/lib/alerting/acknowledge";
import { NEGATIVE_TEXT_CLASS } from "../../../_components/tone";

const UNREACHABLE_ERROR =
  "We couldn’t reach the server to acknowledge these alerts. Check your connection and try again.";

export function AcknowledgeAllButton({ alertIds }: { alertIds: string[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  const count = alertIds.length;
  if (count === 0) return null;

  const acknowledgeAll = () => {
    setError(null);
    startTransition(async () => {
      let result: Awaited<ReturnType<typeof acknowledgeAlerts>>;
      try {
        result = await acknowledgeAlerts({ alertIds });
      } catch {
        setError(UNREACHABLE_ERROR);
        return;
      }
      if (result.ok) {
        router.refresh();
        return;
      }
      setError(result.error);
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={acknowledgeAll}
        disabled={pending}
        aria-label={`Acknowledge all ${count} shown alerts`}
      >
        <CheckCheckIcon aria-hidden />
        {pending ? "Acknowledging…" : `Acknowledge all ${count}`}
      </Button>
      {error ? (
        <p role="alert" className={`max-w-[16rem] text-right text-[11px] leading-4 ${NEGATIVE_TEXT_CLASS}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
