"use client";

/**
 * The Review & Approvals DECISION controls — the human-in-the-loop seam made
 * usable. Writer roles only (agency_admin | operator); the server actions
 * enforce the same `requireOperator()` floor + RLS, so this is an honest UX
 * mirror of that floor, never the security boundary.
 *
 * Every control calls a LANDED R3 action verbatim (record verdict ×2, approve,
 * send-back, resubmit) — this UI invents no endpoint and pre-checks no verdict.
 * APPROVE is enabled ONLY when {@link evaluateApprovalGate} (the exported engine
 * that mirrors the strengthened DB CHECK) already returns ok; otherwise it is
 * disabled with the engine's own reason. The DB CHECK remains the real gate; the
 * action re-evaluates server-side, so a stale client can never approve past it.
 *
 * One shared transition guards against double-submit: while any decision is in
 * flight every control is disabled (plus an explicit re-entry guard in `run`).
 * Failures render the action's interface-voice error verbatim; successes
 * announce through the persistent live region and router-refresh so the row's
 * NEW status is visible immediately. Branch-changing successes (approve /
 * send-back / resubmit) also move FOCUS into the replacing branch — the acting
 * button unmounts with the branch swap, and focus must never drop to <body>.
 */

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type {
  AutomationLevel,
  ContentItemStatus,
  ContentItemType,
  HumanizationResult,
} from "@/lib/types/db";
import {
  evaluateApprovalGate,
  humanizationRequired,
  type ApprovalBlocker,
} from "@/lib/production/review";
import {
  approveContentItem,
  recordComplianceVerdict,
  recordQualityVerdict,
  resubmitContentItem,
  sendBackContentItem,
  type ReviewActionResult,
} from "@/lib/production/review/actions";
// The same caps the server actions clamp with — ONE pure source of truth, no
// literal mirror to drift (Code Review c2).
import { NOTE_MAX, REASON_MAX } from "@/lib/production/review/limits";
import { announceReview } from "../../_components/announcer";
import { POSITIVE_TEXT_CLASS, WARM_TEXT_CLASS } from "../../_components/tone";

const UNREACHABLE_ERROR =
  "We couldn’t reach the server to record that. Check your connection and try again.";

/** Gate-input slice the panel needs to mirror the approval engine (serializable). */
export type GateVerdictInput = { passed: boolean | null; bodyHash: string | null } | null;

export interface DecisionPanelProps {
  contentItemId: string;
  status: ContentItemStatus;
  /** Writer role — the only roles that see decision controls (RLS/action floor mirror). */
  canDecide: boolean;
  type: ContentItemType;
  automationLevel: AutomationLevel;
  bodyHash: string;
  quality: GateVerdictInput;
  compliance: GateVerdictInput;
  /** M9 gate result; null when authenticity hasn't run. */
  humanizationPasses: boolean | null;
  /**
   * Server-resolved approver line for the approved branch (e.g. "Approved by
   * you · Jul 10, 2026, 3:04 PM"); null when not approved / unresolvable.
   */
  approvedLine?: string | null;
}

/** Honest, precise copy for each approval blocker the engine can return. */
function blockerCopy(blocker: ApprovalBlocker): string {
  switch (blocker) {
    case "quality_missing":
      return "the content-quality verdict hasn’t been recorded yet";
    case "quality_not_passed":
      return "the content-quality verdict hasn’t passed";
    case "quality_stale":
      return "the content-quality verdict was recorded against an earlier revision";
    case "compliance_missing":
      return "the compliance verdict hasn’t been recorded yet";
    case "compliance_not_passed":
      return "the compliance verdict hasn’t passed";
    case "compliance_stale":
      return "the compliance verdict was recorded against an earlier revision";
    case "humanization_required":
      return "the authenticity check hasn’t passed";
  }
}

export function DecisionPanel(props: DecisionPanelProps) {
  const {
    contentItemId,
    status,
    canDecide,
    type,
    automationLevel,
    bodyHash,
    quality,
    compliance,
    humanizationPasses,
    approvedLine,
  } = props;

  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  // m1: near-control confirmation + a per-gate remount key so a successful
  // record clears its form (without clobbering the OTHER gate's in-progress note).
  const [confirmed, setConfirmed] = React.useState<{
    quality: string | null;
    compliance: string | null;
  }>({ quality: null, compliance: null });
  const [formEpoch, setFormEpoch] = React.useState({ quality: 0, compliance: 0 });

  // M3: a branch-changing success (approve / send-back / resubmit) unmounts the
  // acting button — without intervention focus drops to <body>. Each status
  // branch's root registers itself as the focus target (only one is mounted at
  // a time); when the refreshed status prop arrives after such a decision, focus
  // moves into the replacing branch. Verdict recording keeps the branch (status
  // stays in_review), so the effect — keyed on a status CHANGE — never fires for it.
  const focusTargetRef = React.useRef<HTMLElement | null>(null);
  const wantFocusRef = React.useRef(false);
  const prevStatusRef = React.useRef(status);
  const setFocusTarget = React.useCallback((el: HTMLElement | null) => {
    focusTargetRef.current = el;
  }, []);
  React.useEffect(() => {
    if (prevStatusRef.current === status) return;
    prevStatusRef.current = status;
    if (wantFocusRef.current) {
      wantFocusRef.current = false;
      focusTargetRef.current?.focus();
    }
  }, [status]);

  // M4: recording a verdict must ALSO not drop keyboard focus to <body> — two
  // compounding mechanisms would: the clicked "Record verdict" button becomes
  // `disabled` when pending flips (browsers evict focus from disabled
  // elements), and the m1 epoch remount then destroys/recreates the recorder
  // subtree. The status-keyed M3 effect structurally never fires here (status
  // stays in_review by design), and avoiding the remount alone would NOT be
  // sufficient (the disabled-eviction path remains) — so this is the SAME
  // want-flag/target-ref mechanism, applied per recorder: a successful record
  // flags its gate, and this effect — keyed on the EPOCH — focuses the freshly
  // remounted recorder's root after it commits.
  const qualityRecorderRef = React.useRef<HTMLDivElement | null>(null);
  const complianceRecorderRef = React.useRef<HTMLDivElement | null>(null);
  const wantRecorderFocusRef = React.useRef<"quality" | "compliance" | null>(null);
  React.useEffect(() => {
    const gate = wantRecorderFocusRef.current;
    if (gate === null) return; // never steal focus on mount / unrelated renders
    wantRecorderFocusRef.current = null;
    const target = gate === "quality" ? qualityRecorderRef : complianceRecorderRef;
    target.current?.focus();
  }, [formEpoch]);

  const run = React.useCallback(
    (
      action: () => Promise<ReviewActionResult>,
      success: string,
      opts?: { movesFocus?: boolean; onSuccess?: () => void }
    ) => {
      // c1: the double-submit invariant is LOCAL — an explicit re-entry guard,
      // not a dependency on React's disabled-flush timing.
      if (pending) return;
      setError(null);
      startTransition(async () => {
        let res: ReviewActionResult;
        try {
          res = await action();
        } catch {
          setError(UNREACHABLE_ERROR);
          return;
        }
        if (res.ok) {
          wantFocusRef.current = opts?.movesFocus === true;
          opts?.onSuccess?.();
          announceReview(success);
          router.refresh();
        } else {
          setError(res.error);
        }
      });
    },
    [router, pending]
  );

  // Read-only variant — no controls, an honest line about why.
  if (!canDecide) {
    return (
      <p className="text-xs leading-5 text-muted">
        Recording a review decision is an agency-staff action. You can read
        everything here, but the decision controls are shown to reviewers only.
      </p>
    );
  }

  if (status === "approved" || status === "published") {
    return (
      <div ref={setFocusTarget} tabIndex={-1} className="flex flex-col gap-1.5 outline-none">
        <p className="text-sm leading-6 text-muted">
          This draft has been approved — its verdicts are recorded and locked to
          this revision. There is nothing left to decide here.
        </p>
        {approvedLine ? (
          <p className="text-sm font-medium text-ink">{approvedLine}</p>
        ) : null}
      </div>
    );
  }

  if (status === "draft") {
    return (
      <p className="text-sm leading-6 text-muted">
        This draft hasn’t been submitted for review yet, so there’s nothing to
        decide. It will appear here once it enters review.
      </p>
    );
  }

  if (status === "needs_revision") {
    return (
      <div ref={setFocusTarget} tabIndex={-1} className="flex flex-col gap-3 outline-none">
        <p className="text-sm leading-6 text-muted">
          This draft was sent back for revision. When the writer has addressed
          the notes above, return it to review so fresh verdicts can be recorded.
        </p>
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              run(() => resubmitContentItem({ contentItemId }), "Returned to review.", {
                movesFocus: true,
              })
            }
          >
            {pending ? "Returning…" : "Return to review"}
          </Button>
        </div>
        <ErrorLine error={error} />
      </div>
    );
  }

  // status === "in_review" — the full decision surface.
  //
  // Null-coalescing on the gate inputs is a FAIL-CLOSED projection, not a
  // semantic choice (Code Review c3): a malformed stored verdict (non-boolean
  // `passed` → null, missing `body_hash` → null) coalesces to values the engine
  // REJECTS (`false` fails the passed check; `""` never equals a real sha256
  // hash) — exactly how the engine itself treats the raw jsonb (`!== true` /
  // `!== rowHash`). Equivalent acceptance set, and the server action + the DB
  // CHECK re-enforce the real gate regardless of anything computed here.
  const gate = evaluateApprovalGate({
    type,
    automationLevel,
    bodyHash,
    quality: quality ? { passed: quality.passed ?? false, body_hash: quality.bodyHash ?? "" } : null,
    compliance: compliance
      ? { passed: compliance.passed ?? false, body_hash: compliance.bodyHash ?? "" }
      : null,
    // Only `.passes` is consumed by the engine (it mirrors the DB CHECK
    // `humanization @> '{"passes":true}'`); the other fields are never read.
    humanization:
      humanizationPasses === null ? null : ({ passes: humanizationPasses } as HumanizationResult),
  });

  return (
    <div ref={setFocusTarget} tabIndex={-1} className="flex flex-col gap-6 outline-none">
      <div className="grid gap-4 sm:grid-cols-2">
        <VerdictRecorder
          key={`quality-${formEpoch.quality}`}
          rootRef={qualityRecorderRef}
          gate="quality"
          label="Content-quality verdict"
          disabled={pending}
          confirmation={confirmed.quality}
          onRecord={(passed, note) =>
            run(
              () => recordQualityVerdict({ contentItemId, passed, note }),
              `Content-quality verdict recorded — ${passed ? "passed" : "failed"}.`,
              {
                onSuccess: () => {
                  wantRecorderFocusRef.current = "quality";
                  setConfirmed((c) => ({
                    ...c,
                    quality: `Recorded — ${passed ? "passed" : "failed"}.`,
                  }));
                  setFormEpoch((e) => ({ ...e, quality: e.quality + 1 }));
                },
              }
            )
          }
        />
        <VerdictRecorder
          key={`compliance-${formEpoch.compliance}`}
          rootRef={complianceRecorderRef}
          gate="compliance"
          label="Compliance verdict"
          disabled={pending}
          confirmation={confirmed.compliance}
          onRecord={(passed, note) =>
            run(
              () => recordComplianceVerdict({ contentItemId, passed, note }),
              `Compliance verdict recorded — ${passed ? "passed" : "failed"}.`,
              {
                onSuccess: () => {
                  wantRecorderFocusRef.current = "compliance";
                  setConfirmed((c) => ({
                    ...c,
                    compliance: `Recorded — ${passed ? "passed" : "failed"}.`,
                  }));
                  setFormEpoch((e) => ({ ...e, compliance: e.compliance + 1 }));
                },
              }
            )
          }
        />
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
        <span className="text-sm font-medium text-ink">Approve</span>
        <p className="text-xs leading-5 text-muted">
          Approval requires both gate verdicts to have passed against this exact
          revision{humanizationRequired(type, automationLevel) ? ", plus a passing authenticity check" : ""}.
          Approving records your decision against this revision; it does not push
          anything live.
        </p>
        <div>
          <Button
            type="button"
            size="sm"
            disabled={pending || !gate.ok}
            onClick={() =>
              run(
                () => approveContentItem({ contentItemId }),
                "Approved — recorded under your name.",
                { movesFocus: true }
              )
            }
          >
            {pending ? "Working…" : "Approve"}
          </Button>
        </div>
        {!gate.ok ? (
          <p className="text-xs leading-5 text-muted">
            Can’t approve yet — {blockerCopy(gate.blocker)}.
          </p>
        ) : null}
      </div>

      <SendBackForm
        disabled={pending}
        onSendBack={(gate2, reason) =>
          run(
            () => sendBackContentItem({ contentItemId, gate: gate2, reason }),
            "Sent back for revision.",
            { movesFocus: true }
          )
        }
      />

      <ErrorLine error={error} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Verdict recorder (one gate)                                         */
/* ------------------------------------------------------------------ */

function VerdictRecorder({
  rootRef,
  gate,
  label,
  disabled,
  confirmation,
  onRecord,
}: {
  /** M4: the parent focuses this root after a successful record remounts the form. */
  rootRef: React.Ref<HTMLDivElement>;
  gate: "quality" | "compliance";
  label: string;
  disabled: boolean;
  /** Near-control echo of the last successful record (m1); null before any. */
  confirmation: string | null;
  onRecord: (passed: boolean, note: string | undefined) => void;
}) {
  const [decision, setDecision] = React.useState<"pass" | "fail" | null>(null);
  const [note, setNote] = React.useState("");
  const noteId = `${gate}-note`;

  const noteRequired = decision === "fail";
  const noteMissing = noteRequired && note.trim() === "";

  const submit = () => {
    if (decision === null) return;
    if (noteMissing) return;
    onRecord(decision === "pass", note.trim() === "" ? undefined : note.trim());
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="flex flex-col gap-2 rounded-lg border border-border p-4 outline-none"
    >
      <span className="text-sm font-medium text-ink">{label}</span>
      <div className="flex gap-2">
        <Button
          type="button"
          size="xs"
          variant={decision === "pass" ? "default" : "outline"}
          disabled={disabled}
          aria-pressed={decision === "pass"}
          onClick={() => setDecision("pass")}
        >
          Pass
        </Button>
        <Button
          type="button"
          size="xs"
          variant={decision === "fail" ? "default" : "outline"}
          disabled={disabled}
          aria-pressed={decision === "fail"}
          onClick={() => setDecision("fail")}
        >
          Fail
        </Button>
      </div>
      <label htmlFor={noteId} className="text-xs text-muted">
        {noteRequired ? "Note (required for a fail)" : "Note (optional)"}
      </label>
      <Textarea
        id={noteId}
        value={note}
        maxLength={NOTE_MAX}
        disabled={disabled}
        onChange={(e) => setNote(e.target.value)}
        placeholder={
          noteRequired
            ? "What needs to change? The writer sees this."
            : "Anything worth recording with this verdict."
        }
        className="min-h-16 text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        {noteMissing ? (
          <span className={`text-[11px] ${WARM_TEXT_CLASS}`}>
            Add a note so a fail is actionable.
          </span>
        ) : confirmation ? (
          // m1: the form resets on success (fresh remount) and this echo sits
          // right where the operator acted; the panels above carry the detail.
          <span className={`text-[11px] ${POSITIVE_TEXT_CLASS}`}>{confirmation}</span>
        ) : (
          <span />
        )}
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled || decision === null || noteMissing}
          onClick={submit}
        >
          Record verdict
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Send-back form                                                      */
/* ------------------------------------------------------------------ */

function SendBackForm({
  disabled,
  onSendBack,
}: {
  disabled: boolean;
  onSendBack: (gate: "quality" | "compliance", reason: string) => void;
}) {
  const [gate, setGate] = React.useState<"quality" | "compliance">("quality");
  const [reason, setReason] = React.useState("");
  const reasonMissing = reason.trim() === "";

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
      <span className="text-sm font-medium text-ink">Send back for revision</span>
      <p className="text-xs leading-5 text-muted">
        Returns the draft to the writer with your reason recorded as the failing
        gate’s note. Re-review is required before it can be approved.
      </p>
      <fieldset className="flex flex-wrap gap-2" disabled={disabled}>
        <legend className="sr-only">Which gate is returning this draft</legend>
        <Button
          type="button"
          size="xs"
          variant={gate === "quality" ? "default" : "outline"}
          aria-pressed={gate === "quality"}
          onClick={() => setGate("quality")}
        >
          From content quality
        </Button>
        <Button
          type="button"
          size="xs"
          variant={gate === "compliance" ? "default" : "outline"}
          aria-pressed={gate === "compliance"}
          onClick={() => setGate("compliance")}
        >
          From compliance
        </Button>
      </fieldset>
      <label htmlFor="send-back-reason" className="text-xs text-muted">
        Reason (required)
      </label>
      <Textarea
        id="send-back-reason"
        value={reason}
        maxLength={REASON_MAX}
        disabled={disabled}
        onChange={(e) => setReason(e.target.value)}
        placeholder="What must the writer fix before this can pass?"
        className="min-h-16 text-sm"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted">
          {reason.length}/{REASON_MAX}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || reasonMissing}
          onClick={() => onSendBack(gate, reason.trim())}
        >
          {disabled ? "Working…" : "Send back"}
        </Button>
      </div>
    </div>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className="text-[13px] leading-5 text-[color-mix(in_oklab,var(--negative)_70%,var(--ink))] dark:text-negative"
    >
      {error}
    </p>
  );
}
