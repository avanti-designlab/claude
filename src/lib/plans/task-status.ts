/**
 * Plan-task manual status: the LEGAL human-driven transitions on `tasks.status`
 * (doc 03 §3 lifecycle, §6 automation_level). Pure + side-effect-free (no server
 * imports, no Supabase) so it is unit-tested in the default `npm test` run and
 * shared by both the sanctioned write action (update-status.ts, which re-enforces
 * every rule below via a CAS) and the plan-tab UI (which only ever renders a
 * control this module says is legal).
 *
 * WHAT IS MANUALLY MOVABLE, AND WHAT IS DELIBERATELY NOT:
 *
 * The `tasks` status enum admits SEVEN statuses (migration 0004 + 0013):
 *   todo | in_progress | in_review | approved | published | reverted | done
 * There is NO database transition trigger (unlike `runs`, which carries
 * runs_transition_guard in 0012 — the Orchestrator ruled that FSM treatment
 * unwarranted for tasks). So the database constrains the SET of statuses and the
 * done⇒human_only coupling (0013's tasks_done_is_human_only CHECK), but not which
 * EDGE is legal; edge legality is a product decision, and a free-form manual
 * write must never bypass a review/publish gate (CLAUDE.md rules 3–5) or imply a
 * client-site write that never happened (rule 4).
 *
 * `automation_level` (doc 03 §6) decides who OWNS a task's status:
 *   - `auto`            — machine-owned (rank tracking, reporting, freshness).
 *                         A human never hand-drives these; NO manual control.
 *   - `ai_draft_human_approve` — the CONTENT/CHANGE decisions (in_review →
 *                         approved → published) belong to the R3 content
 *                         lifecycle + change-management layer and are NEVER a
 *                         free-form task write. But no pipeline writer moves these
 *                         tasks off `todo` yet, so a human may hand-track their
 *                         work with the same gate-free, reversible edge as a
 *                         human task: todo ⇄ in_progress ONLY. `done` and every
 *                         pipeline/gate word stay structurally unreachable here
 *                         (done is human_only-only in the DB; the CAS refuses the
 *                         rest). WIRING-TIME CONDITION (recorded, ruling 2): when
 *                         the pipeline→task writer lands, its gate must define how
 *                         this manual work-tracking reconciles with the pipeline's
 *                         own status writes.
 *   - `human_only`      — genuine human work (strategy, compliance sign-off,
 *                         participation). No AI/publish pipeline drives it, so its
 *                         status is genuinely human-owned: todo ⇄ in_progress AND
 *                         in_progress ⇄ done ("Mark done" / "Reopen"). `done` is
 *                         plain work-tracking ("I finished this task"), reversible,
 *                         and — by the 0013 CHECK — can NEVER stand on a machine or
 *                         pipeline task, so it can never be mistaken for the
 *                         approved/published audit terminals.
 *
 * THE LEGAL MANUAL EDGES (single source of truth — MANUAL_EDGES below):
 *   todo         ⇄ in_progress   (both non-auto levels; "Start" / "Move back")
 *   in_progress  ⇄ done          (human_only only; "Mark done" / "Reopen")
 * Every edge is gate-free, asserts no site write, and is reversible — plain
 * "I picked this up / put it back / finished it / reopened it". No edge reaches
 * in_review/approved/published/reverted, so those stay unreachable by hand for
 * every level (the pipeline/gate words are never a manual write).
 */

import type { AutomationLevel, TaskStatus } from "@/lib/types/db";

/** Non-auto automation levels — the ones a human may hand-track work on. */
const HUMAN_AND_PIPELINE: readonly AutomationLevel[] = [
  "human_only",
  "ai_draft_human_approve",
];
/** Genuinely human-owned only — the levels a `done` edge is legal on. */
const HUMAN_ONLY: readonly AutomationLevel[] = ["human_only"];

/** The status values a human may TARGET through the sanctioned manual action. */
export const LEGAL_MANUAL_TARGETS = ["todo", "in_progress", "done"] as const;
export type LegalManualTarget = (typeof LEGAL_MANUAL_TARGETS)[number];

/** Narrow an unknown target to the legal set (used before any DB round-trip). */
export function isLegalManualTarget(value: unknown): value is LegalManualTarget {
  return value === "todo" || value === "in_progress" || value === "done";
}

/**
 * One legal manual edge: the source status a task must currently hold, the
 * target it moves to, the automation levels the edge is legal on, and the
 * button copy. This ONE table drives both `manualActionsFor` (what the UI
 * offers) and `manualCasFor` (the predicates the write CAS re-pins), so the two
 * can never drift.
 */
interface ManualEdge {
  from: TaskStatus;
  to: LegalManualTarget;
  levels: readonly AutomationLevel[];
  /** Interface-voice label (doc 06 §6 — name the thing the operator controls). */
  label: string;
  /** Past-tense confirmation announced on success. */
  done: string;
}

/* Array order IS render order per source status (manualActionsFor preserves
 * it): for `in_progress` the FORWARD action ("Mark done") leads and the
 * backward one ("Move back") follows — a design ruling, safe because
 * manualCasFor filters by target, never by position. */
const MANUAL_EDGES: readonly ManualEdge[] = [
  {
    from: "todo",
    to: "in_progress",
    levels: HUMAN_AND_PIPELINE,
    label: "Start task",
    done: "Task started.",
  },
  {
    from: "in_progress",
    to: "done",
    levels: HUMAN_ONLY,
    label: "Mark done",
    done: "Task marked done.",
  },
  {
    from: "in_progress",
    to: "todo",
    levels: HUMAN_AND_PIPELINE,
    label: "Move back to to-do",
    done: "Task moved back to to-do.",
  },
  {
    from: "done",
    to: "in_progress",
    levels: HUMAN_ONLY,
    label: "Reopen",
    done: "Task reopened.",
  },
];

/** One manual control a task offers: the target status + the button's copy. */
export interface ManualAction {
  to: LegalManualTarget;
  /** Interface-voice label (doc 06 §6 — name the thing the operator controls). */
  label: string;
  /** Past-tense confirmation announced on success. */
  done: string;
}

/**
 * The manual controls a task offers, given its automation level + current status.
 * Empty for every task the human does not own the status of (auto, or a status
 * outside the legal edge set) — honest silence, never a control that would 0-row
 * refuse. A human_only task in `in_progress` offers TWO controls ("Mark done"
 * leading, "Move back" second); every other legal (level, status) offers at
 * most one.
 */
export function manualActionsFor(
  automationLevel: AutomationLevel,
  status: TaskStatus
): ManualAction[] {
  return MANUAL_EDGES.filter(
    (edge) => edge.from === status && edge.levels.includes(automationLevel)
  ).map((edge) => ({ to: edge.to, label: edge.label, done: edge.done }));
}

/**
 * The compare-and-set predicates the write action re-pins for a given TARGET —
 * derived from the SAME edge table `manualActionsFor` renders from, so the write
 * can never allow a move the UI wouldn't offer:
 *   - `sources`: the status(es) a row must currently hold for `to` to be legal
 *     (the CAS `status IN (...)` — an honest "it already moved" on 0 rows, never
 *     a silent clobber). `in_progress` has TWO sources (`todo` for Start, `done`
 *     for Reopen); the others have one.
 *   - `levels`: the automation levels the move is legal on (the CAS
 *     `automation_level IN (...)` — `auto` is always excluded).
 *
 * SAFETY of the `levels` union for the `in_progress` target: its two edges are
 * Start (from `todo`, both non-auto levels) and Reopen (from `done`, human_only
 * only), so the union is [human_only, ai_draft_human_approve]. That coarsening is
 * sound because `done` is human_only-only IN THE DATABASE (0013's
 * tasks_done_is_human_only CHECK): an ai_draft_human_approve row can never hold
 * `done`, so the coarsened predicate admits, on every REACHABLE row, exactly the
 * legal edges — an ai_draft `todo` row Starts; a human_only `todo`/`done` row
 * Starts/Reopens; nothing else matches. The 0013 CHECK is the AUTHORITATIVE
 * backstop regardless (it rejects any `done` on a non-human_only row); this
 * predicate exists for honest conflict semantics, not as the security boundary.
 * A future change to MANUAL_EDGES must re-check this union.
 */
export function manualCasFor(
  to: LegalManualTarget
): { sources: readonly TaskStatus[]; levels: readonly AutomationLevel[] } | null {
  const edges = MANUAL_EDGES.filter((edge) => edge.to === to);
  if (edges.length === 0) return null;
  const sources = edges.map((edge) => edge.from);
  const levels = Array.from(new Set(edges.flatMap((edge) => edge.levels)));
  return { sources, levels };
}

/**
 * An honest status-ownership note for a task's detail view — TOTAL over the
 * automation levels, so every task discloses who owns its status and where the
 * limits sit (Design Review M2: the completion gap must be disclosed ALONGSIDE
 * the control, not only where no control exists):
 *  - auto: the system owns it — nothing to change by hand.
 *  - ai_draft_human_approve: a human may hand-track work (started / not-started),
 *    but the CONTENT decisions still happen in the review queue, and the future
 *    pipeline writer will reconcile this manual state with the pipeline's (the
 *    recorded wiring-time condition).
 *  - human_only: the human owns it fully — start, mark done, or reopen — and
 *    `done` is work-tracking that never stands in for a review/change approval.
 */
export function statusNote(automationLevel: AutomationLevel): string {
  switch (automationLevel) {
    case "auto":
      return "This task runs automatically — the system sets its status, so there’s nothing to change by hand.";
    case "ai_draft_human_approve":
      return "You can mark this task started or not-started to track your own work. The content decisions — approve it or send it back — still happen in the review queue, never here; when the production pipeline is wired it will reconcile this manual state with the pipeline’s.";
    case "human_only":
      return "You own this task: start it, mark it done, or reopen it as the work moves. Marking it done tracks that the work is finished — it never stands in for a content or change-management approval.";
  }
}
