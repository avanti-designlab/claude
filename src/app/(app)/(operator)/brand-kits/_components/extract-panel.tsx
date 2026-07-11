"use client";

/**
 * Paste-URL brand pull — the operator flow over the LANDED brand_extract queue
 * kind. Paste the client's website address → the background processor fetches
 * it through the egress-guarded, socket-pinned crawler seam → the pure engine
 * proposes a draft kit → THIS panel shows the proposal for review. "Fill the
 * form below" only PREFILLS the ingest form (via the wrapper remounting it) —
 * the proposed values pass through the same preview → WCAG contrast gate →
 * explicit confirm lock as hand-typed input. Nothing is pre-approved, nothing
 * auto-locks (AI drafts, humans approve).
 *
 * HONESTY RULES CARRIED FORWARD:
 *  - Every state renders a REAL runs/drafts row or a REAL action outcome in the
 *    action's own interface voice — no internal codes (the closed error_code
 *    enum maps to plain language), no fabricated progress percentages.
 *  - A failed state read renders as a read failure, never as "no pull yet".
 *  - Candidate/logo/imagery URLs are rendered as PLAIN TEXT — this panel never
 *    loads bytes from the extracted URLs (the operator hasn't vetted them; the
 *    asset library is the vetted home for real files).
 *  - Colors render a swatch ONLY when the value is hex-shaped (the engine emits
 *    normalized hex; anything else renders as text, never as a style value).
 *  - Auto-refresh runs ONLY while a run is queued/running, pauses when the tab
 *    is hidden, and stops at terminal (the audit-runs cadence).
 *  - PER-PROPOSAL STATE LIVES IN THE PROPOSAL: `DraftReview` is keyed by
 *    draftId and owns the logo choice + both inline confirms, so nothing chosen
 *    on a dismissed proposal can ever leak into a newer one (Design M1).
 *
 * Utilitarian operator surface (doc 06 §4/§5): no glow, no signature motion.
 */

import * as React from "react";
import { GlobeIcon, LoaderCircleIcon, RotateCwIcon, SparklesIcon } from "lucide-react";

import { makeAnnouncer } from "@/components/announcer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { enqueueRun } from "@/lib/runs/enqueue";
import {
  discardBrandExtractDraft,
  getBrandExtractState,
  type BrandExtractState,
  type ExtractRunView,
} from "../_actions/extract";
import { StatusPill } from "../../../_components/surface";
import { NEGATIVE_TEXT_CLASS, WARM_TEXT_CLASS } from "@/components/tone";
import {
  DRAFT_COLOR_KEYS,
  DRAFT_FACE_KEYS,
  type ExtractDraftView,
} from "./extract-shared";
import type { ExtractFormPrefill } from "./brand-kit-form";

/* ------------------------------------------------------------------ */
/* Copy + small helpers                                                 */
/* ------------------------------------------------------------------ */

/** Closed error_code → plain product voice (WHAT happened). Never a raw code. */
function errorCodeCopy(code: string | null): string {
  switch (code) {
    case "orphaned":
      return "The pull was interrupted before it finished.";
    case "budget_exhausted_total":
      return "The site took too long to read — a slow or very large site may need another try.";
    case "crawl_refused":
      return "We couldn’t reach that site safely — it may block automated visits, be unreachable, or not be a public website.";
    case "misconfigured":
      return "The pull couldn’t start correctly. Start it again from here.";
    case "engine_error":
      return "Something went wrong while reading the site.";
    default:
      // Defensive: an unmapped/absent code never renders raw — honest fallback.
      return "The pull failed.";
  }
}

const SEAM_UNREACHABLE =
  "We couldn’t reach the platform just now. Check your connection and try again.";

/** Auto-refresh cadence while a pull is queued/running (audit-runs cadence). */
const AUTO_REFRESH_MS = 6_000;

/** Exactly the engine's normalized-hex forms — a swatch renders ONLY for these. */
const SWATCH_HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

const COLOR_LABEL: Record<(typeof DRAFT_COLOR_KEYS)[number], string> = {
  accent: "Accent",
  accentSecondary: "Secondary accent",
  accentWarm: "Warm accent",
  surface: "Surface",
  surfaceRaised: "Raised surface",
  ink: "Ink",
  muted: "Muted",
  positive: "Positive",
  negative: "Negative",
};

const FACE_LABEL: Record<(typeof DRAFT_FACE_KEYS)[number], string> = {
  display: "Display",
  body: "Body",
  mono: "Mono",
};

const { announce, Announcer } = makeAnnouncer();

/* ------------------------------------------------------------------ */
/* Props                                                                */
/* ------------------------------------------------------------------ */

export interface ExtractPanelProps {
  clientId: string;
  clientName: string;
  /** Server-loaded initial state — a returning operator sees an in-flight pull
   *  or a waiting proposal immediately, without a client round-trip. */
  initialState: BrandExtractState;
  /** Hand the reviewed values to the form (the wrapper remounts it). */
  onUse: (prefill: ExtractFormPrefill) => void;
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

export function ExtractPanel({ clientId, clientName, initialState, onUse }: ExtractPanelProps) {
  const [state, setState] = React.useState<BrandExtractState>(initialState);
  const [url, setUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  const run = state.ok ? state.run : null;
  const draft = state.ok ? state.draft : null;
  const watching = run !== null && (run.status === "queued" || run.status === "running");

  /* ---- state refresh (manual + gentle auto while queued/running) ---- */

  // Mirror of `state` for transition detection OUTSIDE the setState updater —
  // updaters must stay pure (StrictMode double-invokes them), so announcements
  // can never live inside one.
  const stateRef = React.useRef(state);
  React.useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refresh = React.useCallback(async () => {
    let next: BrandExtractState;
    try {
      next = await getBrandExtractState(clientId);
    } catch {
      return; // transient — keep the last honest state rather than flicker
    }
    // Announce the arrival of a proposal / a terminal failure once, comparing
    // against the mirrored previous state (pure updater; no announce replay).
    const prev = stateRef.current;
    const prevRun = prev.ok ? prev.run : null;
    const prevDraft = prev.ok ? prev.draft : null;
    if (next.ok) {
      if (next.draft && (!prevDraft || prevDraft.draftId !== next.draft.draftId)) {
        announce("A proposed brand kit is ready to review.");
      } else if (
        next.run &&
        next.run.status === "failed" &&
        (!prevRun || prevRun.status !== "failed")
      ) {
        announce("The brand pull failed.");
      }
    }
    stateRef.current = next;
    setState(next);
  }, [clientId]);

  React.useEffect(() => {
    if (!watching) return;
    const tick = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = window.setInterval(tick, AUTO_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [watching, refresh]);

  /* ---- keyboard focus continuity after a confirmed dismiss ----
     The proposal (with focus inside it) unmounts; the paste form appears.
     Land focus on the address input — the next real action. The announcer
     covers screen readers; this covers keyboard users (Design m6). */
  const pasteInputRef = React.useRef<HTMLInputElement>(null);
  const wantPasteFocus = React.useRef(false);
  React.useEffect(() => {
    if (wantPasteFocus.current && !draft && !watching) {
      wantPasteFocus.current = false;
      pasteInputRef.current?.focus();
    }
  });

  /* ---- start a pull ---- */

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await enqueueRun({ kind: "brand_extract", clientId, url });
      if (res.ok) {
        announce("Brand pull started.");
        await refresh();
      } else {
        setNotice(res.error);
      }
    } catch {
      setNotice(SEAM_UNREACHABLE);
    }
    setBusy(false);
  };

  /* ---- dismiss the proposal ---- */

  const dismiss = async (draftId: string) => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await discardBrandExtractDraft({ clientId, draftId });
      if (!res.ok) setNotice(res.error);
      else {
        announce("Proposed kit dismissed.");
        wantPasteFocus.current = true;
      }
    } catch {
      setNotice(SEAM_UNREACHABLE);
    }
    await refresh();
    setBusy(false);
  };

  /* ---- hand the reviewed values to the form ---- */

  const applyToForm = (d: ExtractDraftView, chosenLogo: string | null) => {
    onUse({
      draftId: d.draftId,
      colors: d.colors,
      typography: d.typography,
      logoUrl: chosenLogo,
    });
    announce("Form filled with the proposed values. Review and adjust below.");
  };

  /* ---- render ---- */

  return (
    <section
      aria-label="Pull the brand from their website"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface-raised p-5"
    >
      <Announcer />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <SparklesIcon aria-hidden className="size-4 text-accent" strokeWidth={1.75} />
          <h2 className="font-display text-lg font-bold tracking-tight text-ink">
            Pull the brand from their website
          </h2>
        </div>
        {/* The pill never overstates: queued is "Queued", not "Reading". */}
        {watching ? (
          <StatusPill tone="accent">
            {run.status === "queued" ? "Queued" : "Reading the site"}
          </StatusPill>
        ) : draft ? (
          <StatusPill tone="warm">Proposal ready</StatusPill>
        ) : null}
      </div>

      {!state.ok ? (
        // A read blip mid-pull must not dead-end the panel: the honest error
        // plus a retry — one click resumes the watch when the read recovers.
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">{state.error}</p>
          <div>
            <Button type="button" variant="outline" size="sm" onClick={refresh}>
              <RotateCwIcon aria-hidden /> Check again
            </Button>
          </div>
        </div>
      ) : draft ? (
        // Keyed by draftId: the logo choice + confirm states are THIS proposal's
        // and reset structurally when a newer proposal arrives (Design M1).
        <DraftReview
          key={draft.draftId}
          draft={draft}
          run={run}
          busy={busy}
          onUse={(chosenLogo) => applyToForm(draft, chosenLogo)}
          onDismiss={() => dismiss(draft.draftId)}
        />
      ) : watching && run ? (
        <WatchingState run={run} onRefresh={refresh} />
      ) : (
        <PasteForm
          clientName={clientName}
          url={url}
          onUrl={setUrl}
          busy={busy}
          onStart={start}
          failedRun={run !== null && run.status === "failed" ? run : null}
          inputRef={pasteInputRef}
        />
      )}

      {notice ? (
        <p role="alert" className={"text-xs leading-5 " + NEGATIVE_TEXT_CLASS}>
          {notice}
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-views                                                            */
/* ------------------------------------------------------------------ */

function PasteForm({
  clientName,
  url,
  onUrl,
  busy,
  onStart,
  failedRun,
  inputRef,
}: {
  clientName: string;
  url: string;
  onUrl: (v: string) => void;
  busy: boolean;
  onStart: () => void;
  failedRun: ExtractRunView | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs leading-5 text-muted">
        Paste {clientName}&rsquo;s website address and the platform reads it —
        colors, fonts, logo and imagery leads — and proposes a starting kit. You
        review everything first: nothing joins the kit until it passes the
        form&rsquo;s accessibility check and you lock it yourself.
      </p>
      {failedRun ? (
        <p className={"text-xs leading-5 " + NEGATIVE_TEXT_CLASS}>
          The last pull
          {failedRun.inputUrl ? (
            <>
              {" of "}
              <span className="font-mono break-all">{failedRun.inputUrl}</span>
            </>
          ) : null}{" "}
          didn&rsquo;t make it: {errorCodeCopy(failedRun.errorCode)}
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="brand-extract-url" className="text-xs">
          Website address
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="brand-extract-url"
            ref={inputRef}
            value={url}
            onChange={(e) => onUrl(e.target.value)}
            placeholder="https://theclient.com"
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            className="max-w-md font-mono"
          />
          <Button type="button" size="sm" onClick={onStart} disabled={busy || url.trim() === ""}>
            {busy ? (
              <LoaderCircleIcon aria-hidden className="animate-spin" />
            ) : (
              <GlobeIcon aria-hidden />
            )}
            Pull the brand
          </Button>
        </div>
      </div>
    </div>
  );
}

function WatchingState({
  run,
  onRefresh,
}: {
  run: ExtractRunView;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink">
        Reading{" "}
        {run.inputUrl ? (
          <span className="font-mono text-xs break-all">{run.inputUrl}</span>
        ) : (
          "the site"
        )}
        …
      </p>
      <p className="text-xs leading-5 text-muted">
        {run.status === "queued"
          ? "Waiting for a worker to pick it up — this usually takes a few seconds."
          : "Fetching the homepage and its stylesheets through the safety checks. This checks itself every few seconds."}
      </p>
      {run.status === "running" && run.heartbeatStale ? (
        <p className={"text-xs leading-5 " + WARM_TEXT_CLASS}>
          No recent progress signal — if this doesn&rsquo;t resolve, the platform
          retries or reports the failure here on its own.
        </p>
      ) : null}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onRefresh}>
          <RotateCwIcon aria-hidden /> Check now
        </Button>
      </div>
    </div>
  );
}

/**
 * One proposal's review card. MUST be rendered with key=draftId — the logo
 * choice and both inline confirms live here so they die with the proposal.
 */
function DraftReview({
  draft,
  run,
  busy,
  onUse,
  onDismiss,
}: {
  draft: ExtractDraftView;
  run: ExtractRunView | null;
  busy: boolean;
  onUse: (chosenLogo: string | null) => void;
  onDismiss: () => void;
}) {
  const [chosenLogo, setChosenLogo] = React.useState<string | null>(draft.logoUrl);
  const [confirmUse, setConfirmUse] = React.useState(false);
  const [confirmDismiss, setConfirmDismiss] = React.useState(false);
  // Cancel returns focus to the trigger it came from (Design m6).
  const useTriggerRef = React.useRef<HTMLButtonElement>(null);
  const dismissTriggerRef = React.useRef<HTMLButtonElement>(null);

  const colorEntries = DRAFT_COLOR_KEYS.filter((k) => draft.colors[k] !== undefined);
  const faceEntries = DRAFT_FACE_KEYS.filter((k) => draft.typography[k] !== undefined);
  // The logo choice set: the engine's top pick + alternates, deduped, order kept.
  const logoOptions = Array.from(
    new Set([...(draft.logoUrl ? [draft.logoUrl] : []), ...draft.logoCandidates])
  );
  const sourceLine =
    run && run.status === "succeeded" && run.inputUrl ? run.inputUrl : null;

  const cancelUse = () => {
    setConfirmUse(false);
    // Focus returns after the trigger remounts — defer one frame.
    requestAnimationFrame(() => useTriggerRef.current?.focus());
  };
  const cancelDismiss = () => {
    setConfirmDismiss(false);
    requestAnimationFrame(() => dismissTriggerRef.current?.focus());
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs leading-5 text-muted">
        Proposed{sourceLine ? (
          <>
            {" "}from <span className="font-mono break-all">{sourceLine}</span>
          </>
        ) : null}
        . These are suggestions read from the site — review and adjust; nothing
        joins the kit until you complete the form&rsquo;s own review and lock
        steps. Addresses below are shown as text only (nothing is loaded from
        the site here) — add real files to the client&rsquo;s asset library.
      </p>

      {colorEntries.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-ink">Colors</h3>
          <ul className="flex flex-wrap gap-2">
            {colorEntries.map((key) => {
              const value = draft.colors[key]!;
              const swatchable = SWATCH_HEX_RE.test(value);
              return (
                <li
                  key={key}
                  className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5"
                >
                  {swatchable ? (
                    <span
                      aria-hidden
                      className="size-4 shrink-0 rounded-sm border border-border"
                      style={{ backgroundColor: value }}
                    />
                  ) : null}
                  <span className="text-xs text-muted">{COLOR_LABEL[key]}</span>
                  <span className="font-mono text-xs text-ink">{value}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {faceEntries.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-ink">Fonts</h3>
          <ul className="flex flex-col gap-1">
            {faceEntries.map((key) => (
              <li key={key} className="flex items-baseline gap-2 text-xs">
                <span className="text-muted">{FACE_LABEL[key]}</span>
                <span className="font-mono break-all text-ink">{draft.typography[key]}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {logoOptions.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-ink">
            Logo — pick the address to prefill
          </legend>
          <div className="flex flex-col gap-1.5">
            {logoOptions.map((option) => (
              <label key={option} className="flex items-start gap-2 text-xs">
                <input
                  type="radio"
                  name="extract-logo-choice"
                  checked={chosenLogo === option}
                  onChange={() => setChosenLogo(option)}
                  className="mt-0.5 accent-accent"
                />
                <span className="font-mono break-all text-ink">{option}</span>
              </label>
            ))}
            <label className="flex items-start gap-2 text-xs">
              <input
                type="radio"
                name="extract-logo-choice"
                checked={chosenLogo === null}
                onChange={() => setChosenLogo(null)}
                className="mt-0.5 accent-accent"
              />
              <span className="text-muted">No logo for now</span>
            </label>
          </div>
        </fieldset>
      ) : null}

      {draft.imageryCandidates.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-ink">Imagery leads</h3>
          <ul className="flex flex-col gap-1">
            {draft.imageryCandidates.map((u) => (
              <li key={u} className="font-mono text-xs break-all text-muted">
                {u}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {draft.notes.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-ink">How these were read</h3>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {draft.notes.map((note) => (
              <li key={note} className="text-xs leading-5 text-muted">
                {note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {confirmUse ? (
          <>
            <span className="text-xs text-muted">
              Fill the form below with these values? Anything already typed there
              is replaced.
            </span>
            {/* Cancel takes focus (house rule: a held Enter can never confirm). */}
            <Button type="button" variant="outline" size="sm" autoFocus onClick={cancelUse}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => {
                setConfirmUse(false);
                onUse(chosenLogo);
              }}
            >
              Fill the form
            </Button>
          </>
        ) : confirmDismiss ? (
          <>
            <span className="text-xs text-muted">
              Dismiss this proposal? You can pull the site again any time.
            </span>
            <Button type="button" variant="outline" size="sm" autoFocus onClick={cancelDismiss}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={onDismiss}
            >
              {busy ? <LoaderCircleIcon aria-hidden className="animate-spin" /> : null}
              Dismiss
            </Button>
          </>
        ) : (
          <>
            {/* One verb carried through: Fill the form below → Fill the form →
                "Form filled with the proposed values." (Design m3) */}
            <Button
              type="button"
              ref={useTriggerRef}
              size="sm"
              disabled={busy}
              onClick={() => setConfirmUse(true)}
            >
              Fill the form below
            </Button>
            <Button
              type="button"
              ref={dismissTriggerRef}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmDismiss(true)}
            >
              Dismiss proposal
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
