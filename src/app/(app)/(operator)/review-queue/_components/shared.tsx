import type {
  AutomationLevel,
  ContentItemStatus,
  ContentItemType,
  SiteChangeMethod,
  SiteChangeStatus,
  SiteChangeType,
} from "@/lib/types/db";
import type { AuthenticityVerdictView } from "@/lib/production/authenticity";
import { StatusPill } from "../../../_components/surface";
import type { VerdictView } from "@/lib/production/review/detail-reads";
import { WARM_TEXT_CLASS } from "./tone";

/**
 * Server-safe presentation helpers for the Review & Approvals studio — shared
 * by the queue, the content-item detail, and the site-change detail. NO client
 * hooks (these render inside Server Components), token-driven, deliberately
 * QUIET (doc 06 §4/§5: operator module UIs are utilitarian — no glow, no
 * signature motion). NO internal module codes ever reach a rendered label
 * (doc 06 §6).
 *
 * Honesty is the through-line: absent ≠ zero, "not run" ≠ failed, and a verdict
 * bound to an earlier body hash is labelled as such rather than silently trusted.
 */

/* ------------------------------------------------------------------ */
/* Labels (no internal codes — operator-facing names only)             */
/* ------------------------------------------------------------------ */

export const CONTENT_TYPE_NOUN: Record<ContentItemType, string> = {
  blog: "Blog post",
  faq: "FAQ",
  caption: "Social caption",
  pillar: "Pillar page",
  schema_copy: "Schema copy",
};

export const CONTENT_STATUS_LABEL: Record<ContentItemStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  needs_revision: "In revision",
  approved: "Approved",
  published: "Published",
};

const CONTENT_STATUS_TONE: Record<
  ContentItemStatus,
  "muted" | "accent" | "positive" | "warm" | "negative"
> = {
  draft: "muted",
  in_review: "accent",
  needs_revision: "warm",
  approved: "positive",
  published: "positive",
};

export const AUTOMATION_LABEL: Record<AutomationLevel, string> = {
  auto: "Automated",
  ai_draft_human_approve: "AI draft · human approves",
  human_only: "Human only",
};

export const CHANGE_TYPE_NOUN: Record<SiteChangeType, string> = {
  h1: "H1 heading",
  title: "Page title",
  meta: "Meta description",
  schema: "Structured data",
  alt: "Image alt text",
  content: "On-page content",
  canonical: "Canonical tag",
};

export const CHANGE_METHOD_LABEL: Record<SiteChangeMethod, string> = {
  wordpress: "WordPress",
  webflow: "Webflow",
  wix: "Wix",
  edge_worker: "Edge worker",
  pr: "Pull request",
};

export const CHANGE_STATUS_LABEL: Record<SiteChangeStatus, string> = {
  previewed: "Previewed",
  applied: "Applied",
  reverted: "Reverted",
  auto_reverted: "Auto-rolled back",
};

const CHANGE_STATUS_TONE: Record<
  SiteChangeStatus,
  "muted" | "accent" | "positive" | "warm" | "negative"
> = {
  previewed: "accent",
  applied: "positive",
  reverted: "warm",
  auto_reverted: "negative",
};

export function ContentStatusPill({ status }: { status: ContentItemStatus }) {
  return <StatusPill tone={CONTENT_STATUS_TONE[status]}>{CONTENT_STATUS_LABEL[status]}</StatusPill>;
}

export function ChangeStatusPill({ status }: { status: SiteChangeStatus }) {
  return <StatusPill tone={CHANGE_STATUS_TONE[status]}>{CHANGE_STATUS_LABEL[status]}</StatusPill>;
}

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const DATE_TIME_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** A date, or an honest em-dash when the stamp isn't parseable — never a fake date. */
export function medDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

export function medDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_TIME_MED.format(t) : "—";
}

/* ------------------------------------------------------------------ */
/* Gate-verdict panel (quality / compliance)                           */
/* ------------------------------------------------------------------ */

const GATE_LABEL = {
  quality: "Content quality",
  compliance: "Compliance",
} as const;

/**
 * One gate's recorded verdict, rendered honestly:
 *  - no verdict object            → "No verdict yet";
 *  - passed / failed              → the gate's own decision, with its note;
 *  - bound hash ≠ current hash    → "recorded against an earlier revision";
 *  - bound hash MISSING           → equally not-approvable (the approval engine
 *    treats a hash-less verdict as stale — `body_hash !== rowHash` — so the
 *    panel must agree with the blocker on malformed data, never show a clean
 *    "Passed" the gate would refuse).
 */
export function VerdictPanel({
  gate,
  verdict,
  currentBodyHash,
}: {
  gate: "quality" | "compliance";
  verdict: VerdictView | null;
  currentBodyHash: string;
}) {
  const unbound = verdict != null && verdict.bodyHash == null;
  const mismatch =
    verdict != null &&
    verdict.bodyHash != null &&
    currentBodyHash !== "" &&
    verdict.bodyHash !== currentBodyHash;
  const stale = unbound || mismatch;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink">{GATE_LABEL[gate]}</span>
        {verdict == null ? (
          <StatusPill tone="muted">No verdict yet</StatusPill>
        ) : verdict.passed === true ? (
          <StatusPill tone="positive">Passed</StatusPill>
        ) : verdict.passed === false ? (
          <StatusPill tone="negative">Failed</StatusPill>
        ) : (
          <StatusPill tone="muted">Recorded</StatusPill>
        )}
      </div>

      {verdict == null ? (
        <p className="text-xs leading-5 text-muted">
          This gate hasn&apos;t recorded a decision on this draft yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {stale ? (
            <p className={`text-xs leading-5 ${WARM_TEXT_CLASS}`}>
              {unbound
                ? "Not bound to this revision — the verdict needs re-recording before approval."
                : "Recorded against an earlier revision — the content changed since, so it needs re-reviewing before approval."}
            </p>
          ) : null}
          {verdict.note ? (
            <p className="text-sm leading-6 whitespace-pre-wrap text-ink">{verdict.note}</p>
          ) : (
            <p className="text-xs leading-5 text-muted">No note was recorded.</p>
          )}
          <p className="font-mono text-[11px] text-muted">
            Recorded {medDateTime(verdict.reviewedAt)}
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Humanization / AI-detection panel                                   */
/* ------------------------------------------------------------------ */

function pct(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

/**
 * The multi-detector authenticity panel. Renders ONLY what M9 stored — verbatim
 * per-detector scores. A row that isn't an object / M9 that hasn't run reads as
 * "not run" (view === null), NEVER a fabricated zero. A detector marked
 * unavailable renders "not available", never a 0% pass.
 */
export function HumanizationPanel({ view }: { view: AuthenticityVerdictView | null }) {
  if (view == null) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-ink">Authenticity check</span>
          <StatusPill tone="muted">Not run</StatusPill>
        </div>
        <p className="mt-2 text-xs leading-5 text-muted">
          The humanization and AI-detection check hasn&apos;t run on this draft
          yet — no scores to show.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-ink">Authenticity check</span>
        {view.passes ? (
          <StatusPill tone="positive">Passed</StatusPill>
        ) : view.verdict === "flagged_for_human" ? (
          <StatusPill tone="warm">Flagged for a human</StatusPill>
        ) : (
          <StatusPill tone="muted">Not cleared</StatusPill>
        )}
      </div>

      {view.detectors.length === 0 ? (
        <p className="text-xs leading-5 text-muted">
          No individual detector readings were recorded.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {view.detectors.map((d, i) => (
            <li key={`${d.vendor}-${i}`} className="flex items-center justify-between gap-3 py-2">
              <span className="truncate font-mono text-xs text-muted">{d.vendor}</span>
              {!d.available ? (
                <span className="shrink-0 font-mono text-xs text-muted">Not available</span>
              ) : (
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-xs text-ink">{pct(d.aiLikelihood)} AI-like</span>
                  {d.belowThreshold === true ? (
                    <StatusPill tone="positive">Reads human</StatusPill>
                  ) : d.belowThreshold === false ? (
                    <StatusPill tone="warm">Reads machine</StatusPill>
                  ) : null}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
        <dt>Aggregate AI-likelihood</dt>
        <dd className="text-right font-mono text-ink">{pct(view.aggregate.score)}</dd>
        <dt>Detectors available</dt>
        <dd className="text-right font-mono text-ink">
          {view.aggregate.detectorsAvailable ?? "—"}
          {view.quorum.required != null ? ` / ${view.quorum.required} needed` : ""}
        </dd>
        {view.thresholds.passAt != null ? (
          <>
            <dt>Pass threshold</dt>
            <dd className="text-right font-mono text-ink">at or below {pct(view.thresholds.passAt)}</dd>
          </>
        ) : null}
      </dl>

      {view.flaggedReasons.length > 0 ? (
        <p className={`text-xs leading-5 ${WARM_TEXT_CLASS}`}>
          {/* Dedupe after mapping: multiple unmapped reasons collapse to one
              neutral entry instead of repeating it. */}
          Flagged: {[...new Set(view.flaggedReasons.map(humanizeFlag))].join(", ")}.
        </p>
      ) : null}
    </div>
  );
}

function humanizeFlag(reason: string): string {
  switch (reason) {
    case "meaning_drift":
      return "meaning drifted from the original";
    case "voice_drift":
      return "voice drifted from the brand";
    case "detection_above_threshold":
      return "reads as machine-generated";
    case "compliance_regression":
      return "a required disclosure changed";
    default:
      // An unmapped stored token is an internal code — never render it raw
      // (doc 06 §6). A neutral phrase keeps the sentence honest without leaking.
      return "an additional authenticity flag";
  }
}
