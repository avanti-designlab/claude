"use client";

/**
 * The caption brief — compose one on-brand social caption and hand it to M11's
 * `createSocialCaption`. Writer roles only (the page renders this only when
 * `canWrite`; `createSocialCaption` enforces `requireOperator()` + RLS below
 * regardless, so this is an honest UX mirror of that floor, never the boundary).
 *
 * It calls the LANDED `createSocialCaption` VERBATIM — no invented endpoint, no
 * field the contract doesn't accept:
 *   - topic (required; the engine clamps to CAPTION_TOPIC_MAX);
 *   - groundingFacts (optional; the ONLY facts the caption may assert — the
 *     engine's anti-fabrication set). One fact per line;
 *   - platform (optional; tailors the caption + its compliance pre-screen to
 *     where it will run — NOT a connector, nothing posts).
 * There is NO media field here: media is BRAND-FORCED server-side through the
 * deferred Higgsfield/Motion port and has no persistence home yet — it is its own
 * (deferred) section on the page, not a field on this form.
 *
 * HONEST OUTCOMES. The generation vendor (Anthropic — the SAME deferred seam M8
 * uses) is fail-closed, so today a real submit returns `generation_unavailable` —
 * rendered as a DESIGNED, calm state that names what has to connect and links to
 * Connections, never a red error. The form comes alive with ZERO code change the
 * moment the vendor wires: the same submit then persists a real caption and the
 * pipeline below shows it.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRightIcon, PaletteIcon, PlugZapIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
// Imported from the actions module DIRECTLY (mirrors the Content Studio brief
// form), so the client bundle pulls only the "use server" action, not the whole
// social barrel with its pure caption/media/compose modules.
import { createSocialCaption } from "@/lib/social/actions";
import {
  CAPTION_GROUNDING_FACT_MAX,
  CAPTION_GROUNDING_FACTS_MAX,
  CAPTION_PLATFORM_OPTIONS,
  CAPTION_TOPIC_MAX,
  CONNECTIONS_HREF,
} from "./caption-pipeline";
import {
  NEGATIVE_TEXT_CLASS,
  POSITIVE_TEXT_CLASS,
} from "../../../_components/tone";

const SELECT_CLASS =
  "h-9 rounded-md border border-input bg-transparent px-2 text-sm text-ink outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

/**
 * Honest fallback when the action call itself fails to round-trip. A lost
 * response is UNKNOWABLE — the caption may or may not have persisted — so the
 * copy never claims "nothing was saved"; the catch path refreshes the page's
 * server reads so the pipeline below shows the truth (house pattern).
 */
const SEAM_UNREACHABLE =
  "We couldn’t confirm whether that started — we’ve refreshed the pipeline below; check it before trying again.";

type Outcome =
  | null
  | { kind: "success" }
  | { kind: "not_connected" }
  | { kind: "no_kit" }
  | { kind: "note"; message: string }
  | { kind: "error"; message: string };

export function CaptionBriefForm({
  clientId,
  clientName,
}: {
  clientId: string;
  clientName: string;
}) {
  const router = useRouter();
  const [topic, setTopic] = React.useState("");
  const [facts, setFacts] = React.useState("");
  const [platform, setPlatform] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [outcome, setOutcome] = React.useState<Outcome>(null);

  const topicTrimmed = topic.trim();

  // CLIENT-SIDE HONESTY FOR THE SERVER CLAMPS: the action silently drops facts
  // past CAPTION_GROUNDING_FACTS_MAX and truncates any fact past
  // CAPTION_GROUNDING_FACT_MAX — so instead of letting a submit silently lose
  // input, the form names the problem and blocks until the operator trims it.
  const factLines = facts
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const factsProblem =
    factLines.length > CAPTION_GROUNDING_FACTS_MAX
      ? `Only the first ${CAPTION_GROUNDING_FACTS_MAX} facts would be used — trim the list to ${CAPTION_GROUNDING_FACTS_MAX} or fewer.`
      : factLines.some((line) => line.length > CAPTION_GROUNDING_FACT_MAX)
        ? `One of these facts is longer than ${CAPTION_GROUNDING_FACT_MAX.toLocaleString("en-US")} characters and would be cut off — shorten it.`
        : null;

  const canSubmit = topicTrimmed !== "" && factsProblem === null && !pending;

  const submit = async () => {
    // Local re-entry guard (not a dependency on React's disabled-flush timing).
    if (pending || topicTrimmed === "" || factsProblem !== null) return;
    setPending(true);
    setOutcome(null);
    const groundingFacts = factLines;
    try {
      const res = await createSocialCaption({
        clientId,
        topic: topicTrimmed,
        groundingFacts,
        ...(platform !== "" ? { platform } : {}),
      });
      if (res.ok) {
        // Server truth: the caption persists now (pinned pre-approval draft).
        // Refresh so the pipeline below shows it (no optimistic fabrication).
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
        // forbidden / not_found / invalid_input / generation_failed / write_failed —
        // each is already interface voice with no internal codes.
        setOutcome({ kind: "error", message: res.error });
      }
    } catch {
      // Unconfirmed round-trip: re-run the page's server reads so the pipeline
      // reflects whether the caption landed (the copy promises this).
      router.refresh();
      setOutcome({ kind: "error", message: SEAM_UNREACHABLE });
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Topic / brief */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="caption-topic" className="text-muted">
          What’s the caption about?
        </Label>
        <Textarea
          id="caption-topic"
          value={topic}
          maxLength={CAPTION_TOPIC_MAX}
          disabled={pending}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="The angle or moment this post covers, e.g. “New waterfront listing in the marina — open house this weekend.”"
          className="min-h-20 text-sm"
        />
        <div className="flex justify-end">
          <span className="font-mono text-[11px] text-muted">
            {topic.length}/{CAPTION_TOPIC_MAX}
          </span>
        </div>
      </div>

      {/* Platform (optional) — the compliance platform signal, not a connector */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="caption-platform" className="text-muted">
          Where will it run? <span className="normal-case">(optional)</span>
        </Label>
        <select
          id="caption-platform"
          value={platform}
          disabled={pending}
          onChange={(e) => setPlatform(e.target.value)}
          className={SELECT_CLASS}
        >
          {CAPTION_PLATFORM_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <p className="text-xs leading-5 text-muted">
          Tailors the caption and its compliance check to the platform. It doesn’t
          post anything — publishing is always a separate, approved step.
        </p>
      </div>

      {/* Grounding facts (optional, real engine field) */}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="caption-facts" className="text-muted">
          Facts it may state <span className="normal-case">(optional, one per line)</span>
        </Label>
        <Textarea
          id="caption-facts"
          value={facts}
          disabled={pending}
          aria-invalid={factsProblem ? true : undefined}
          aria-describedby={factsProblem ? "caption-facts-problem" : undefined}
          onChange={(e) => setFacts(e.target.value)}
          placeholder={
            "Only what you can verify — the caption won’t assert anything outside this list.\nOpen house Saturday 1–3pm\n3 beds, 2 baths, on the marina"
          }
          className="min-h-20 text-sm"
        />
        {factsProblem ? (
          <p
            id="caption-facts-problem"
            role="alert"
            className={`text-[13px] leading-5 ${NEGATIVE_TEXT_CLASS}`}
          >
            {factsProblem}
          </p>
        ) : null}
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs leading-5 text-muted">
            These are the only facts the caption is allowed to state — so it can’t
            invent claims. Leave it empty for a general caption.
          </p>
          <span className="shrink-0 font-mono text-[11px] text-muted">
            {factLines.length}/{CAPTION_GROUNDING_FACTS_MAX} facts
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {/* HOUSE TRADE-OFF (Design Review, 2026-07-10): the submit control
            disables while pending, which evicts keyboard focus to <body> for the
            in-flight window. Accepted app-wide; outcomes are announced via the
            role="status"/"alert" outcome block instead. */}
        <Button type="button" disabled={!canSubmit} onClick={submit}>
          {pending ? "Starting…" : "Draft caption"}
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
        Caption drafted — it’s in the caption pipeline below.
      </p>
    );
  }

  if (outcome.kind === "not_connected") {
    // THE designed, honest deferred-vendor state (calm, not an error). Nothing is
    // persisted on this refusal, so the copy promises only what's true: the
    // inputs stay in the form, and the operator resubmits once it's wired.
    return (
      <DesignedState
        icon={PlugZapIcon}
        title="Caption writing isn’t connected yet"
        body="Captions can’t be written until the AI writing vendor is wired up. Your inputs are kept right here — once the connection is live, press Draft caption again."
        link={{ href: CONNECTIONS_HREF, label: "See Connections" }}
      />
    );
  }

  if (outcome.kind === "no_kit") {
    return (
      <DesignedState
        icon={PaletteIcon}
        title="This client needs a brand kit first"
        body="We won’t write without a locked brand voice — falling back to a generic voice is exactly what the pipeline exists to prevent. Create the brand kit, then come back to draft this caption."
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
