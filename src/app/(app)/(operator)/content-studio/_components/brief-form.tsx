"use client";

/**
 * The brief form — compose one piece and hand it to the M8 generator. Writer
 * roles only (the page renders this only when `canWrite`; `createContentDraft`
 * enforces `requireOperator()` + RLS below regardless, so this is an honest UX
 * mirror of that floor, never the boundary).
 *
 * It calls the LANDED `createContentDraft` VERBATIM — no invented endpoint, no
 * field the contract doesn't accept:
 *   - contentType ∈ blog | faq | pillar (the M8 GENERATABLE set; captions and
 *     schema are other modules and are NOT offered here);
 *   - topic (required; the engine clamps to 500 chars);
 *   - groundingFacts (optional; the ONLY facts the draft may state as fact — the
 *     engine's anti-fabrication set). One fact per line.
 * There is NO title field: `CreateContentDraftInput` has none and M8's insert row
 * never writes `content_items.title`; the working title is produced BY the
 * generator (returned as `result.title`). Capturing a title at brief time would
 * be a field that silently goes nowhere — flagged (STUDIO_TITLE_AT_BRIEF_GAP),
 * not faked.
 *
 * HONEST OUTCOMES. The generation vendor (Anthropic) is deferred/fail-closed, so
 * today a real submit returns `generation_unavailable` — rendered as a DESIGNED,
 * calm state that names what has to connect and links to Connections, never a red
 * error. The form comes alive with ZERO code change the moment the vendor wires:
 * the same submit then returns a real draft and the pipeline board shows it.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRightIcon, PaletteIcon, PlugZapIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createContentDraft } from "@/lib/production/content/actions";
// The clamps are the ENGINE'S OWN exported constants (content/types.ts) — the
// same values the server action applies, so the form can't drift from them.
import {
  GENERATABLE_CONTENT_TYPES,
  GROUNDING_FACT_MAX,
  GROUNDING_FACTS_MAX,
  TOPIC_MAX,
  type GeneratableContentType,
} from "@/lib/production/content/types";
import { CONNECTIONS_HREF, CONTENT_TYPE_META } from "./pipeline";
import {
  NEGATIVE_TEXT_CLASS,
  POSITIVE_TEXT_CLASS,
} from "../../../_components/tone";

/**
 * Honest fallback when the action call itself fails to round-trip. A lost
 * response is UNKNOWABLE — the draft may or may not have been created — so the
 * copy never claims "nothing was saved"; the catch path refreshes the page's
 * server reads so the Draft lane below shows the truth (house pattern).
 */
const SEAM_UNREACHABLE =
  "We couldn’t confirm whether that started — we’ve refreshed the pipeline below; check the Draft lane before trying again.";

type Outcome =
  | null
  | { kind: "success" }
  | { kind: "not_connected" }
  | { kind: "no_kit" }
  | { kind: "note"; message: string }
  | { kind: "error"; message: string };

export function BriefForm({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [type, setType] = React.useState<GeneratableContentType>("blog");
  const [topic, setTopic] = React.useState("");
  const [facts, setFacts] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome>(null);

  const topicTrimmed = topic.trim();

  // CLIENT-SIDE HONESTY FOR THE SERVER CLAMPS (CR minor 2): the action silently
  // drops facts past GROUNDING_FACTS_MAX and truncates any fact past
  // GROUNDING_FACT_MAX — so instead of letting a submit silently lose input, the
  // form names the problem and blocks until the operator trims it themselves.
  const factLines = facts
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const factsProblem =
    factLines.length > GROUNDING_FACTS_MAX
      ? `Only the first ${GROUNDING_FACTS_MAX} facts would be used — trim the list to ${GROUNDING_FACTS_MAX} or fewer.`
      : factLines.some((line) => line.length > GROUNDING_FACT_MAX)
        ? `One of these facts is longer than ${GROUNDING_FACT_MAX.toLocaleString("en-US")} characters and would be cut off — shorten it.`
        : null;

  const canSubmit = topicTrimmed !== "" && factsProblem === null && !pending;

  const submit = async () => {
    // Local re-entry guard (not a dependency on React's disabled-flush timing).
    if (pending || topicTrimmed === "" || factsProblem !== null) return;
    setPending(true);
    setOutcome(null);
    const groundingFacts = factLines;
    try {
      const res = await createContentDraft({
        clientId,
        contentType: type,
        topic: topicTrimmed,
        groundingFacts,
      });
      if (res.ok) {
        // Server truth: the draft exists now. Refresh so the pipeline board's
        // Draft lane shows it (no optimistic fabrication).
        setOutcome({ kind: "success" });
        setTopic("");
        setFacts("");
        router.refresh();
      } else if (res.reason === "generation_unavailable") {
        setOutcome({ kind: "not_connected" });
      } else if (res.reason === "no_brand_kit") {
        setOutcome({ kind: "no_kit" });
      } else if (res.reason === "no_playbook") {
        // Dormant vertical (Gate 1a) — the engine's copy is already product voice.
        setOutcome({ kind: "note", message: res.error });
      } else {
        setOutcome({ kind: "error", message: res.error });
      }
    } catch {
      // Unconfirmed round-trip: re-run the page's server reads so the Draft
      // lane reflects whether the create landed (the copy promises this).
      router.refresh();
      setOutcome({ kind: "error", message: SEAM_UNREACHABLE });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Content type — plain-language cards, single choice */}
      <fieldset className="flex flex-col gap-2" disabled={pending}>
        <legend className="text-xs text-muted">What are we producing?</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {GENERATABLE_CONTENT_TYPES.map((t) => {
            const meta = CONTENT_TYPE_META[t];
            const active = type === t;
            return (
              <button
                key={t}
                type="button"
                aria-pressed={active}
                disabled={pending}
                onClick={() => setType(t)}
                className={
                  "flex flex-col gap-1 rounded-lg border px-3.5 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60 " +
                  (active
                    ? "border-accent bg-accent/5"
                    : "border-border bg-surface-raised hover:bg-overlay")
                }
              >
                <span className="text-sm font-medium text-ink">{meta.label}</span>
                <span className="text-xs leading-5 text-muted">{meta.blurb}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* Topic / brief */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="brief-topic" className="text-muted">
          Topic or brief
        </Label>
        <Textarea
          id="brief-topic"
          value={topic}
          maxLength={TOPIC_MAX}
          disabled={pending}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="What should this piece cover? e.g. “First-time homebuyer guide for the North End — process, timelines, local incentives.”"
          className="min-h-24 text-sm"
        />
        <div className="flex justify-end">
          <span className="font-mono text-[11px] text-muted">
            {topic.length}/{TOPIC_MAX}
          </span>
        </div>
      </div>

      {/* Grounding facts (optional, real engine field) */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="brief-facts" className="text-muted">
          Facts it may state <span className="normal-case">(optional, one per line)</span>
        </Label>
        <Textarea
          id="brief-facts"
          value={facts}
          disabled={pending}
          aria-invalid={factsProblem ? true : undefined}
          aria-describedby={factsProblem ? "brief-facts-problem" : undefined}
          onChange={(e) => setFacts(e.target.value)}
          placeholder={
            "Only what you can verify — the draft won’t assert anything outside this list.\nLicensed since 2009\nServes Alachua County, FL"
          }
          className="min-h-20 text-sm"
        />
        {factsProblem ? (
          <p
            id="brief-facts-problem"
            role="alert"
            className={`text-[13px] leading-5 ${NEGATIVE_TEXT_CLASS}`}
          >
            {factsProblem}
          </p>
        ) : null}
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs leading-5 text-muted">
            These are the only facts the draft is allowed to state — so it
            can’t invent facts. Leave it empty for a general piece.
          </p>
          <span className="shrink-0 font-mono text-[11px] text-muted">
            {factLines.length}/{GROUNDING_FACTS_MAX} facts
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/* HOUSE TRADE-OFF (Design Review, 2026-07-10): the submit control
            disables while pending, which evicts keyboard focus to <body> for
            the in-flight window. Accepted app-wide (properties panel, run
            triggers, decision panel share it); outcomes are announced via the
            role="status"/"alert" outcome block instead. Uniform focus restore
            is on the shared polish backlog, not solved per-surface. */}
        <Button type="button" disabled={!canSubmit} onClick={submit}>
          {pending ? "Starting…" : "Create draft"}
        </Button>
        <span className="text-xs leading-5 text-muted">
          Written in {clientName}’s locked brand voice, then routed through the
          pipeline — nothing publishes without a human approval.
        </span>
      </div>

      {outcome ? <OutcomeBlock outcome={outcome} clientId={clientId} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Outcome states                                                      */
/* ------------------------------------------------------------------ */

function OutcomeBlock({
  outcome,
  clientId,
}: {
  outcome: Exclude<Outcome, null>;
  clientId: string;
}) {
  if (outcome.kind === "success") {
    return (
      <p role="status" className={`text-sm ${POSITIVE_TEXT_CLASS}`}>
        Draft created — it’s in the Draft lane below.
      </p>
    );
  }

  if (outcome.kind === "not_connected") {
    // THE designed, honest deferred-vendor state (calm, not an error). Nothing
    // is persisted on this refusal, so the copy promises only what's true: the
    // inputs stay in the form, and the operator resubmits once it's wired.
    return (
      <DesignedState
        icon={PlugZapIcon}
        title="Content generation isn’t connected yet"
        body="Drafts can’t be written until the AI writing vendor is wired up. Your inputs are kept right here — once the connection is live, press Create draft again."
        link={{ href: CONNECTIONS_HREF, label: "See Connections" }}
      />
    );
  }

  if (outcome.kind === "no_kit") {
    return (
      <DesignedState
        icon={PaletteIcon}
        title="This client needs a brand kit first"
        body="We won’t generate without a locked brand voice — falling back to a generic voice is exactly what the pipeline exists to prevent. Create the brand kit, then come back to brief this piece."
        link={{ href: `/brand-kits/new/${clientId}`, label: "Create the brand kit" }}
      />
    );
  }

  if (outcome.kind === "note") {
    return (
      <div
        role="status"
        className="rounded-lg border border-dashed border-border px-4 py-3"
      >
        <p className="text-sm leading-6 text-muted">{outcome.message}</p>
      </div>
    );
  }

  return (
    <p role="alert" className={`text-[13px] leading-5 ${NEGATIVE_TEXT_CLASS}`}>
      {outcome.message}
    </p>
  );
}

function DesignedState({
  icon: Icon,
  title,
  body,
  link,
}: {
  icon: typeof PlugZapIcon;
  title: string;
  body: string;
  link: { href: string; label: string };
}) {
  return (
    // role="status" (Design MAJ-2): these designed outcomes are the most common
    // results of a submit today — they must be announced, not just painted.
    <div
      role="status"
      className="flex items-start gap-3 rounded-lg border border-border bg-surface-raised px-4 py-4"
    >
      <span
        aria-hidden
        className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
      >
        <Icon className="size-4 text-accent" strokeWidth={1.75} />
      </span>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-ink">{title}</span>
        <p className="max-w-xl text-xs leading-5 text-muted">{body}</p>
        <Link
          href={link.href}
          className="mt-0.5 inline-flex w-fit items-center gap-1 rounded text-sm font-medium text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {link.label}
          <ArrowRightIcon aria-hidden className="size-3.5" strokeWidth={2} />
        </Link>
      </div>
    </div>
  );
}
