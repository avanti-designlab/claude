/**
 * Plan-task manual status: the LEGAL human-driven transitions on `tasks.status`
 * (doc 03 §3 lifecycle, §6 automation_level). Pure + side-effect-free (no server
 * imports, no Supabase) so it is unit-tested in the default `npm test` run and
 * shared by both the sanctioned write action (update-status.ts, which re-enforces
 * every rule below via a CAS) and the plan-tab UI (which only ever renders a
 * control this module says is legal).
 *
 * WHY THIS SUBSET, AND WHAT IS DELIBERATELY LEFT OUT (flagged to the Orchestrator):
 *
 * The frozen `tasks` CHECK (migration 0004) admits six statuses —
 *   todo | in_progress | in_review | approved | published | reverted
 * — with NO database transition guard (unlike `runs`, which carries
 * runs_transition_guard in 0012). So the database constrains only the SET of
 * statuses, never which edge is legal; legality is a product decision, and a
 * free-form manual write must not be a way to bypass a review/publish gate
 * (CLAUDE.md rules 3–5) or to imply a client-site write that never happened
 * (rule 4).
 *
 * `automation_level` (doc 03 §6) decides who OWNS a task's status:
 *   - `auto`            — machine-owned (rank tracking, reporting, freshness).
 *                         A human never hand-drives these; NO manual control.
 *   - `ai_draft_human_approve` — pipeline-owned. Its in_review→approved→published
 *                         edges are the CONTENT/CHANGE review gates, owned by the
 *                         R3 content lifecycle + change-management layer, not by a
 *                         free-form task write. NO manual control here (a human
 *                         clicking "Published" must not bypass those gates).
 *   - `human_only`      — genuine human work (strategy, compliance sign-off,
 *                         genuine participation). No AI/publish pipeline drives
 *                         it, so its status is genuinely human-owned. This is the
 *                         one automation level a manual control is legal on.
 *
 * The UNAMBIGUOUS, gate-free, reversible subset for `human_only`:
 *   todo  ⇄  in_progress
 * Both edges bypass no gate and assert no site write; either direction is a
 * plain, reversible "I picked this up / I put it back".
 *
 * FLAGGED, THEN RULED: a terminal "done/complete" for a human_only task was
 * flagged (the frozen CHECK has no `done`; `approved`/`published` are gate/
 * site-write words that must not be overloaded onto "human task complete"),
 * and the Orchestrator has since AUTHORIZED a `done` status (migration 0013,
 * next slice). Until 0013 lands, completion stays un-wired and the UI
 * DISCLOSES the gap (`statusNote`) instead of hiding it. Still deferred: any
 * manual control on `ai_draft_human_approve` tasks (e.g. hand-moving one to
 * in_progress) — plausibly harmless but risks drift from the real
 * content-pipeline state; needs its own ruling.
 */

import type { AutomationLevel, TaskStatus } from "@/lib/types/db";

/** The only status values a human may set through the sanctioned manual action. */
export const LEGAL_MANUAL_TARGETS = ["todo", "in_progress"] as const;
export type LegalManualTarget = (typeof LEGAL_MANUAL_TARGETS)[number];

/** Narrow an unknown target to the legal set (used before any DB round-trip). */
export function isLegalManualTarget(value: unknown): value is LegalManualTarget {
  return value === "todo" || value === "in_progress";
}

/**
 * The status a task MUST currently hold for `to` to be legal — the compare-and-set
 * source. In this two-state subset each target has exactly one legal source, so
 * the caller never supplies (and we never trust) a client-sent "from".
 */
export function requiredSourceFor(to: LegalManualTarget): TaskStatus {
  return to === "in_progress" ? "todo" : "in_progress";
}

/** One manual control a task offers: the target status + the button's verb. */
export interface ManualAction {
  to: LegalManualTarget;
  /** Interface-voice label (doc 06 §6 — name the thing the operator controls). */
  label: string;
  /** Past-tense confirmation announced on success. */
  done: string;
}

/**
 * The manual controls a task offers, given its automation level + current status.
 * Empty for every task the human does not own the status of (auto / pipeline), and
 * empty for a human_only task already outside the legal subset — honest silence,
 * never a control that would 0-row refuse.
 */
export function manualActionsFor(
  automationLevel: AutomationLevel,
  status: TaskStatus
): ManualAction[] {
  if (automationLevel !== "human_only") return [];
  if (status === "todo") {
    return [{ to: "in_progress", label: "Start task", done: "Task started." }];
  }
  if (status === "in_progress") {
    return [
      { to: "todo", label: "Move back to to-do", done: "Task moved back to to-do." },
    ];
  }
  return [];
}

/**
 * An honest status-ownership note for a task's detail view — TOTAL over the
 * automation levels, so every task discloses who owns its status and where the
 * limits sit (Design Review M2: the completion gap must be disclosed ALONGSIDE
 * the control, not only where no control exists):
 *  - auto: the system owns it — nothing to change by hand.
 *  - ai_draft_human_approve: the pipeline owns it — decisions happen in the
 *    review queue, never as a free-form status write.
 *  - human_only: the human owns it, and the manual control covers started /
 *    not-started only — completion is coming (`done`, migration 0013,
 *    Orchestrator-authorized, next slice) and is disclosed until it lands.
 */
export function statusNote(automationLevel: AutomationLevel): string {
  switch (automationLevel) {
    case "auto":
      return "This task runs automatically — the system sets its status, so there’s nothing to change by hand.";
    case "ai_draft_human_approve":
      return "This task moves through the content and approval pipeline — approve or send it back from the review queue, not here.";
    case "human_only":
      return "Marking work complete is coming — for now, a task tracks whether it’s started or not.";
  }
}
