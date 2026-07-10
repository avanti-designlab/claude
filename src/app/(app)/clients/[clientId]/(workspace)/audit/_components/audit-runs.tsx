"use client";

/**
 * Audit-tab run controls + honest live run states (P0 run-trigger UI; the ruled
 * runs-queue A5/A6 states made visible). Deliberately UTILITARIAN — no glow, no
 * signature motion (doc 06 §4/§5, operator surface). Everything it renders is a
 * REAL runs row or a REAL enqueue/cancel outcome; nothing is fabricated:
 *
 *  - Run controls (writer-only, mirroring the enqueue/cancel action floors) call
 *    the LANDED `enqueueRun`/`cancelRun` server actions and render each honest
 *    outcome in the action's own interface voice — no internal codes.
 *  - The run list shows only what a row carries: status pill, kind, target,
 *    datetime, attempt count when past the first attempt, heartbeat freshness on
 *    running rows (via the exported `isHeartbeatStale` mirror — the A5 binding
 *    condition), and the closed error_code mapped to plain language on failures.
 *  - Cancel is offered ONLY on queued rows (the one legal raw tenant edge). No
 *    mid-run cancel affordance exists, by design — we never fake one.
 *  - Freshness without spam: a manual Refresh plus a gentle auto-refresh that
 *    runs ONLY while a queued/running row exists, pauses when the tab is hidden,
 *    and stops at terminal. Reduced-motion suppresses the per-second freshness
 *    ticker (the number still updates on each refresh).
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { GlobeIcon, PlayIcon, RadarIcon, RotateCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useReducedMotion } from "@/components/moments";
import { isHeartbeatStale, RETRY_ATTEMPT_CAP } from "@/lib/runs/config";
import { enqueueRun } from "@/lib/runs/enqueue";
import { cancelRun } from "@/lib/runs/cancel";
import type { RunStatus } from "@/lib/types/db";
import {
  EmptyState,
  FailedState,
  StatusPill,
} from "../../../../../_components/surface";

/* ------------------------------------------------------------------ */
/* Props (all plain, server-serialized data)                           */
/* ------------------------------------------------------------------ */

/** A scannable property, as the page's RLS-scoped read returned it. */
export interface RunProperty {
  id: string;
  url: string;
}

/** One runs row, mapped to exactly what the UI renders (server-shaped). */
export interface RunView {
  id: string;
  status: RunStatus;
  kindLabel: string;
  /** Never negative; 0-based (a fresh run is 0). See attemptLine(). */
  attempts: number;
  /** Epoch ms of last heartbeat, or null (never stamped / unparseable). */
  heartbeatAtMs: number | null;
  /** Closed enum from the row (null unless failed); mapped to plain language. */
  errorCode: string | null;
  /** Pre-formatted server-side (avoids client TZ/hydration drift). */
  createdAtLabel: string;
  /** The scanned property's URL, resolved from property_id (or null). */
  propertyUrl: string | null;
  /** audits.id from a succeeded run's result_ref, or null. */
  resultAuditId: string | null;
  /** Whether that audit id is present in the history section below (anchor). */
  resultInHistory: boolean;
}

interface AuditRunsProps {
  clientId: string;
  /** Writer floor — mirrors the action; read-only users see status, not buttons. */
  canWrite: boolean;
  properties: RunProperty[];
  /** false = the properties read failed (independent failure domain). */
  propertiesOk: boolean;
  runs: RunView[];
  /** false = the runs read failed (writer-only SELECT; empty for viewers is ok). */
  runsOk: boolean;
}

/* ------------------------------------------------------------------ */
/* Pure copy maps (no internal codes ever render)                      */
/* ------------------------------------------------------------------ */

const STATUS_META: Record<
  RunStatus,
  { label: string; tone: "muted" | "accent" | "positive" | "warm" | "negative" }
> = {
  queued: { label: "Queued", tone: "muted" },
  running: { label: "Running", tone: "accent" },
  succeeded: { label: "Succeeded", tone: "positive" },
  failed: { label: "Failed", tone: "negative" },
  canceled: { label: "Canceled", tone: "muted" },
};

/** Closed error_code → plain product voice (WHAT happened). Never a raw code. */
function errorCodeCopy(code: string | null): string {
  switch (code) {
    case "orphaned":
      return "The scan was interrupted before it finished.";
    case "budget_exhausted_total":
      return "The scan ran out of time before it could read the site — a large site may need another run.";
    case "crawl_refused":
      return "The site refused the scan — it may block crawlers or be unreachable.";
    case "misconfigured":
      return "The scan couldn’t start — the property may be missing or not a scannable website.";
    case "engine_error":
      return "Something went wrong while scanning.";
    default:
      // Defensive: an unmapped/absent code never renders raw — honest fallback.
      return "The scan failed.";
  }
}

/**
 * The retry-state clause on a failed row. HONEST to the machinery: the sweeper's
 * requeue_failed_runs re-queues ANY failed run with attempts < cap (past its
 * backoff) — it does not discriminate by error_code — and a run at the cap is
 * terminal. So the clause is driven purely by attempts vs the config cap.
 */
function retryStateCopy(attempts: number): string {
  return attempts < RETRY_ATTEMPT_CAP
    ? "It will retry automatically."
    : "It reached the retry limit — start a new scan to try again.";
}

/**
 * "Attempt N of M" — shown once a run is past its FIRST attempt. `attempts` is
 * the DB's 0-based counter (fresh run = 0; the sweeper increments it by exactly
 * 1 per requeue, up to the structural cap). So the human attempt number is
 * attempts+1 and the maximum number of attempts is cap+1 (the initial attempt
 * plus up to `cap` requeues) — never overstated.
 */
function attemptLine(attempts: number): string | null {
  if (attempts < 1) return null;
  return `Attempt ${attempts + 1} of ${RETRY_ATTEMPT_CAP + 1}`;
}

/** Interface-voice fallback when an action call fails to round-trip. */
const SEAM_UNREACHABLE =
  "We couldn’t confirm that — we’ve refreshed the list so you can see its current state before trying again.";

/** House AA-fixed notice recipes (same color-mix as the Properties panel).
 *  WARM covers the stale-heartbeat callout — raw text-accent-warm measures
 *  ~3:1 on the light card surface (Design M1). */
const POSITIVE_TEXT_CLASS =
  "text-[color-mix(in_oklab,var(--positive)_70%,var(--ink))] dark:text-positive";
const NEGATIVE_TEXT_CLASS =
  "text-[color-mix(in_oklab,var(--negative)_70%,var(--ink))] dark:text-negative";
const WARM_TEXT_CLASS =
  "text-[color-mix(in_oklab,var(--accent-warm)_70%,var(--ink))] dark:text-accent-warm";

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Auto-refresh cadence — modest (heartbeat cadence is 12s, orphan 120s), so a
 *  single interval keeps state fresh without a polling storm. */
const AUTO_REFRESH_MS = 6_000;

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

type Notice = { tone: "positive" | "negative"; message: string };

export function AuditRuns({
  clientId,
  canWrite,
  properties,
  propertiesOk,
  runs,
  runsOk,
}: AuditRunsProps) {
  const router = useRouter();
  const reducedMotion = useReducedMotion();

  // Client clock for relative freshness — null until mount, so SSR never emits a
  // relative time (no hydration mismatch). The 1s ticker advances it while a run
  // is running; a fresh server render (a new `runs` reference) resyncs it.
  const [now, setNow] = React.useState<number | null>(null);
  const [updatedLabel, setUpdatedLabel] = React.useState("");

  // Single in-flight action key ("run:<id>" | "cancel:<id>") — disables every
  // action button so a run/cancel can never be double-submitted or raced.
  const [pending, setPending] = React.useState<string | null>(null);
  // Outcomes rendered where the operator acted: enqueue near the property row,
  // cancel near the run row.
  const [runNotice, setRunNotice] = React.useState<
    (Notice & { propertyId: string }) | null
  >(null);
  const [cancelNotice, setCancelNotice] = React.useState<
    (Notice & { runId: string }) | null
  >(null);

  const hasActive = runs.some(
    (r) => r.status === "queued" || r.status === "running"
  );
  const hasRunning = runs.some((r) => r.status === "running");

  // Mount + every fresh server render: resync the freshness clock and the real
  // "Updated" label. Keyed on the `runs` reference — it changes ONLY when the
  // server sends new data (a local re-render reuses the same prop), so this is
  // the fresh-data signal. Deferred via rAF so no setState runs synchronously in
  // the effect body and no impure clock read happens during render (the accepted
  // pattern — see components/dashboard-preview/count-up.tsx).
  React.useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setNow(Date.now());
      setUpdatedLabel(TIME_FMT.format(new Date()));
    });
    return () => cancelAnimationFrame(raf);
  }, [runs]);

  // Per-second freshness ticker — ONLY while a run is running, the tab is
  // visible, and motion isn't reduced. Under reduced motion the "Ns ago" number
  // still advances on each auto-refresh, just not every second. setState lives in
  // the interval callback (never the effect body).
  React.useEffect(() => {
    if (!hasRunning || reducedMotion) return;
    let id: number | undefined;
    const start = () => {
      if (id === undefined && !document.hidden) {
        id = window.setInterval(() => setNow(Date.now()), 1000);
      }
    };
    const stop = () => {
      if (id !== undefined) {
        window.clearInterval(id);
        id = undefined;
      }
    };
    const onVis = () => {
      if (document.hidden) stop();
      else start();
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [hasRunning, reducedMotion]);

  // Gentle auto-refresh — re-pull server truth while any scan is queued/running;
  // paused when the tab is hidden or an action is in flight; stops at terminal.
  // (CR minor 4, consciously accepted: the interval keeps ticking as a no-op in
  // a hidden tab — refresh() checks document.hidden — which is cosmetic only.)
  React.useEffect(() => {
    if (!hasActive || pending !== null) return;
    let id: number | undefined;
    const refresh = () => {
      if (!document.hidden) router.refresh();
    };
    const start = () => {
      if (id === undefined) id = window.setInterval(refresh, AUTO_REFRESH_MS);
    };
    const stop = () => {
      if (id !== undefined) {
        window.clearInterval(id);
        id = undefined;
      }
    };
    const onVis = () => {
      if (document.hidden) stop();
      else {
        router.refresh();
        start();
      }
    };
    start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [hasActive, pending, router]);

  const onRun = async (propertyId: string) => {
    setPending(`run:${propertyId}`);
    setRunNotice(null);
    try {
      const res = await enqueueRun({ kind: "audit", propertyId });
      if (res.ok) {
        setRunNotice({
          propertyId,
          tone: "positive",
          message: "Audit queued — it shows up in Recent scans below.",
        });
        router.refresh(); // pull the real queued row (server truth, not a fake)
      } else {
        // The action's error is already interface voice with no internal codes.
        setRunNotice({ propertyId, tone: "negative", message: res.error });
      }
    } catch {
      router.refresh();
      setRunNotice({ propertyId, tone: "negative", message: SEAM_UNREACHABLE });
    } finally {
      setPending(null);
    }
  };

  const onCancel = async (runId: string) => {
    setPending(`cancel:${runId}`);
    setCancelNotice(null);
    try {
      const res = await cancelRun({ runId });
      if (res.ok) {
        setCancelNotice({ runId, tone: "positive", message: "Scan canceled." });
        router.refresh();
      } else if (res.reason === "already_started") {
        // The row's state changed under us — show truth. THIS component does the
        // refreshing, so the refresh clause is UI-owned (the action's copy stays
        // caller-neutral, CR minor 3).
        setCancelNotice({
          runId,
          tone: "negative",
          message: `${res.error} We’ve refreshed the list so you can see where it is now.`,
        });
        router.refresh();
      } else {
        setCancelNotice({ runId, tone: "negative", message: res.error });
      }
    } catch {
      router.refresh();
      setCancelNotice({ runId, tone: "negative", message: SEAM_UNREACHABLE });
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Toolbar: honest "as of" + manual refresh */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">
          {updatedLabel ? <span>Updated {updatedLabel}</span> : null}
          {hasActive ? (
            <span>
              {updatedLabel ? " · " : null}auto-refreshing while scans are active
            </span>
          ) : null}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending !== null}
          onClick={() => router.refresh()}
        >
          <RotateCwIcon aria-hidden /> Refresh
        </Button>
      </div>

      {/* Run controls — writer floor mirrors the action */}
      {canWrite ? (
        <section aria-labelledby="run-a-scan-heading" className="flex flex-col gap-3">
          <h3
            id="run-a-scan-heading"
            className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase"
          >
            Run a scan
          </h3>
          {!propertiesOk ? (
            <FailedState subject="this client’s properties" />
          ) : properties.length === 0 ? (
            <EmptyState
              icon={GlobeIcon}
              title="No website to scan yet"
              description="Add this client’s site on the Overview tab, then run an audit against it."
              action={
                <Button asChild size="sm" variant="outline">
                  <Link href={`/clients/${clientId}/overview`}>Go to Overview</Link>
                </Button>
              }
            />
          ) : (
            <ul className="flex flex-col gap-2">
              {properties.map((property) => (
                <li key={property.id} className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3">
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-ink">
                      {property.url}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      disabled={pending !== null}
                      aria-label={`Run audit for ${property.url}`}
                      onClick={() => onRun(property.id)}
                    >
                      {pending === `run:${property.id}` ? (
                        "Queuing…"
                      ) : (
                        <>
                          <PlayIcon aria-hidden /> Run audit
                        </>
                      )}
                    </Button>
                  </div>
                  {runNotice && runNotice.propertyId === property.id ? (
                    <p
                      role={runNotice.tone === "negative" ? "alert" : "status"}
                      className={
                        "text-[13px] leading-5 " +
                        (runNotice.tone === "negative"
                          ? NEGATIVE_TEXT_CLASS
                          : POSITIVE_TEXT_CLASS)
                      }
                    >
                      {runNotice.message}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {/* Recent scans — honest live states */}
      <section aria-labelledby="recent-scans-heading" className="flex flex-col gap-3">
        <h3
          id="recent-scans-heading"
          className="font-mono text-[11px] tracking-[0.14em] text-muted uppercase"
        >
          Recent scans
        </h3>
        {!runsOk ? (
          <FailedState subject="recent scans" />
        ) : runs.length === 0 ? (
          <EmptyState
            icon={RadarIcon}
            title="No scans yet"
            description={
              canWrite
                ? "Queued and completed scans show up here with their live status."
                : "Scans and their status appear here."
            }
          />
        ) : (
          <ul className="flex flex-col">
            {runs.map((run, i) => {
              const meta = STATUS_META[run.status];
              const attempt = attemptLine(run.attempts);
              const freshness =
                run.status === "running" ? runningFreshness(run, now) : null;
              return (
                <li
                  key={run.id}
                  className={
                    "flex flex-col gap-1.5 py-3" +
                    (i > 0 ? " border-t border-border" : "")
                  }
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
                    <span className="text-sm text-ink">{run.kindLabel}</span>
                    {run.propertyUrl ? (
                      <span className="max-w-[16rem] truncate font-mono text-xs text-muted">
                        {run.propertyUrl}
                      </span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted tabular-nums">
                      {run.createdAtLabel}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    {attempt ? <span className="text-muted">{attempt}</span> : null}

                    {freshness ? (
                      <span
                        className={freshness.stale ? WARM_TEXT_CLASS : "text-muted"}
                      >
                        {freshness.text}
                      </span>
                    ) : null}

                    {run.status === "failed" ? (
                      <span className="text-muted">
                        {errorCodeCopy(run.errorCode)} {retryStateCopy(run.attempts)}
                      </span>
                    ) : null}

                    {run.status === "succeeded" ? (
                      run.resultAuditId && run.resultInHistory ? (
                        <a
                          href={`#audit-${run.resultAuditId}`}
                          className="rounded text-accent underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
                        >
                          View result in audit history
                        </a>
                      ) : (
                        // Hedged (CR minor 2): the audit row may sit outside the
                        // rendered history window — "in the audit history" stays
                        // true either way; "below" would not.
                        <span className="text-muted">Results are in the audit history</span>
                      )
                    ) : null}

                    {/* Cancel — ONLY on queued rows (the one legal raw edge). */}
                    {canWrite && run.status === "queued" ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={pending !== null}
                        // Disambiguated per row (Design m2): several queued runs
                        // may render at once, so the accessible name carries the
                        // target + timestamp, never just "Cancel queued Audit".
                        aria-label={`Cancel queued ${run.kindLabel}${
                          run.propertyUrl ? ` — ${run.propertyUrl}` : ""
                        }, ${run.createdAtLabel}`}
                        onClick={() => onCancel(run.id)}
                      >
                        {pending === `cancel:${run.id}` ? "Canceling…" : "Cancel"}
                      </Button>
                    ) : null}
                  </div>

                  {cancelNotice && cancelNotice.runId === run.id ? (
                    <p
                      role={cancelNotice.tone === "negative" ? "alert" : "status"}
                      className={
                        "text-[13px] leading-5 " +
                        (cancelNotice.tone === "negative"
                          ? NEGATIVE_TEXT_CLASS
                          : POSITIVE_TEXT_CLASS)
                      }
                    >
                      {cancelNotice.message}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Heartbeat freshness for a running row (the A5 binding condition), via the
 * exported `isHeartbeatStale` mirror so the UI can never disagree with the SQL
 * reaper. `now` is null until mount — we show a neutral "In progress" then.
 */
function runningFreshness(
  run: RunView,
  now: number | null
): { text: string; stale: boolean } | null {
  if (now === null) return { text: "In progress", stale: false };
  if (isHeartbeatStale(run.heartbeatAtMs, now)) {
    // Stale but not yet swept — honest, never a fake progress bar.
    return { text: "No recent progress", stale: true };
  }
  // heartbeatAtMs is non-null here (a null beat is stale by definition above).
  const secs = Math.max(0, Math.round((now - (run.heartbeatAtMs as number)) / 1000));
  return { text: `Last progress ${secs}s ago`, stale: false };
}
