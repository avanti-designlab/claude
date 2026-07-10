"use client";

/**
 * The Draft lane's per-item pipeline step: run M9's authenticity gate (humanize →
 * AI-detect → advance to review). Writer roles only — the page renders this only
 * when `canWrite`, and `runAuthenticityGate` enforces `requireOperator()` + RLS
 * below regardless.
 *
 * This is a PRODUCTION step, NOT a review decision: it never records a verdict or
 * approves anything (M9 can't — the DB CHECK + pinned status make approved/
 * published unreachable from here). It only moves a draft to `in_review`, where
 * the Review & Approvals studio owns the human decision (one decision surface —
 * this studio never duplicates approve / send-back controls).
 *
 * The humanizer + detector vendors are deferred/fail-closed, so today this
 * honestly refuses with `humanizer_unavailable` / `detection_unavailable` — its
 * OWN designed deferred-vendor state, pointing at Connections. It comes alive the
 * moment those vendors wire: the same click then advances the draft.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { PlayIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { runAuthenticityGate } from "@/lib/production/authenticity";
import { CONNECTIONS_HREF } from "./pipeline";
import {
  NEGATIVE_TEXT_CLASS,
  POSITIVE_TEXT_CLASS,
} from "../../../_components/tone";

const SEAM_UNREACHABLE =
  "We couldn’t confirm that — refreshing so you can see the draft’s current state before trying again.";

type Notice =
  | null
  | { kind: "success"; message: string }
  | { kind: "not_connected"; message: string }
  | { kind: "error"; message: string };

export function DraftAdvance({ contentItemId }: { contentItemId: string }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice>(null);

  const run = async () => {
    if (pending) return;
    setPending(true);
    setNotice(null);
    try {
      const res = await runAuthenticityGate({ contentItemId });
      if (res.ok) {
        setNotice({ kind: "success", message: "Moved to review." });
        router.refresh(); // the row leaves the Draft lane (server truth)
      } else if (
        res.reason === "humanizer_unavailable" ||
        res.reason === "detection_unavailable"
      ) {
        setNotice({ kind: "not_connected", message: res.error });
      } else {
        // Every other reason is already interface voice with no internal codes.
        setNotice({ kind: "error", message: res.error });
      }
    } catch {
      router.refresh();
      setNotice({ kind: "error", message: SEAM_UNREACHABLE });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div>
        {/* HOUSE TRADE-OFF (Design Review, 2026-07-10): disabling while pending
            evicts keyboard focus for the in-flight window — accepted app-wide;
            every outcome below is announced via role="status"/"alert". */}
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={pending}
          aria-label="Run the authenticity check and move this draft to review"
          onClick={run}
        >
          {pending ? (
            "Working…"
          ) : (
            <>
              <PlayIcon aria-hidden /> Run authenticity check
            </>
          )}
        </Button>
      </div>
      {notice ? (
        notice.kind === "not_connected" ? (
          // role="status" (Design MAJ-2): the most common outcome today — a
          // designed deferred-vendor notice must be announced, not just painted.
          <p role="status" className="text-[12px] leading-5 text-muted">
            {notice.message}{" "}
            <Link
              href={CONNECTIONS_HREF}
              className="rounded text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              See Connections
            </Link>
          </p>
        ) : (
          <p
            role={notice.kind === "error" ? "alert" : "status"}
            className={
              "text-[12px] leading-5 " +
              (notice.kind === "error"
                ? NEGATIVE_TEXT_CLASS
                : POSITIVE_TEXT_CLASS)
            }
          >
            {notice.message}
          </p>
        )
      ) : null}
    </div>
  );
}
