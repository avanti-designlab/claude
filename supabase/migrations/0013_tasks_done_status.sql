-- ============================================================================
-- 0013_tasks_done_status.sql — tasks: an honest, human-owned 'done' status.
--
-- Governed post-freeze change (CLAUDE.md rule 1; BUILD-STATE 2026-07-10 "PLAN
-- TAB DEEP BUILD SHIPPED" gate record → ORCHESTRATOR RULING 1). Frozen
-- migrations 0001–0012 are UNTOUCHED. doc 03 §3 (task lifecycle) / §6
-- (automation_level).
--
-- WHY: the plan tab needs an honest way for a human to mark a genuinely
-- human-owned task complete. The frozen tasks status enum (0004) had no
-- completion word, and `approved`/`published` must NOT be overloaded onto
-- "human task complete" — they are load-bearing AUDIT vocabulary (the content
-- review + change-management publish terminals, CLAUDE.md rules 3–5). So a new,
-- plain, work-tracking word is added — 'done' — fenced so it can never become a
-- way to bypass those pipeline terminals.
--
-- TWO structural rules, nothing more:
--   (1) 'done' JOINS the tasks status enum — the ONLY change to the value set.
--   (2) 'done' is legal ONLY on automation_level='human_only'. It is a plain
--       "I finished this task" word for GENUINE human work (strategy,
--       compliance sign-off, participation), NOT a machine or pipeline terminal.
--       A machine-owned (auto) or pipeline (ai_draft_human_approve) task can
--       therefore never be 'done'; those move through their real terminals
--       (rank tracking / reporting for auto; in_review→approved→published under
--       the content + change-management gates for ai_draft_human_approve).
--
-- DELIBERATELY NO TRANSITION TRIGGER (contrast runs_transition_guard, 0012):
-- the Orchestrator ruled the runs-FSM treatment UNWARRANTED here. 'done' is
-- REVERSIBLE work-tracking (done ⇄ in_progress, "Reopen"), a status a human
-- flips as the work moves — not a verdict, not a site write, not a terminal that
-- must be immutable. The legal manual EDGES are app-logic
-- (src/lib/plans/task-status.ts, re-enforced by the updateTaskStatus CAS); this
-- migration constrains only the value SET and the done⇒human_only coupling —
-- exactly the two things that must hold structurally regardless of app code.
--
-- LIVE-DATA NOTE (staging first, per ops/environments.md): the coupling CHECK is
-- added directly (not NOT VALID). Safe because 'done' did not exist in the enum
-- before this migration, so no existing row can hold status='done' — the coupling
-- validates every existing row trivially (status <> 'done' is TRUE for all).
-- Staging application verifies this.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) status enum gains EXACTLY 'done' — nothing else in the frozen set changes.
--     Drop + re-add under the SAME name (mirrors the 0009 content_items idiom)
--     so the existing status-enum expectation still resolves to this constraint.
-- ----------------------------------------------------------------------------
alter table public.tasks
  drop constraint tasks_status_allowed;
alter table public.tasks
  add constraint tasks_status_allowed check (
    status in ('todo', 'in_progress', 'in_review', 'approved', 'published', 'reverted', 'done')
  );

-- ----------------------------------------------------------------------------
-- (2) 'done' is legal ONLY for human_only work. A NARROW STRUCTURAL COUPLING —
--     NOT a transition graph: it says nothing about which edges are legal (that
--     is app-logic), only that the honest completion word can never land on a
--     machine-owned or pipeline task, where approved/published are the real
--     audit terminals. Two-valued and fail-closed by construction: `status` and
--     `automation_level` are both NOT NULL, so the expression is always TRUE or
--     FALSE (never NULL — a Postgres CHECK passes on NULL, so this matters). The
--     honest word can never bypass the pipeline terminals.
-- ----------------------------------------------------------------------------
alter table public.tasks
  add constraint tasks_done_is_human_only check (
    status <> 'done' or automation_level = 'human_only'
  );

comment on constraint tasks_done_is_human_only on public.tasks is
  'doc 03 §6: status=''done'' requires automation_level=''human_only''. ''done'' is honest human-work tracking (reversible: done <-> in_progress), never a bypass of the approved/published pipeline terminals — those stay the content-review + change-management audit vocabulary. auto and ai_draft_human_approve tasks can never be ''done''.';

/* ============================ DOWN (manual rollback — NOT executed) ==========
   Reverses 0013 cleanly to the frozen 0004 tasks status shape (the 0001–0012
   state). This block is a SQL comment: the migration runner executes ONLY the
   UP above. A devops rollback step runs the statements below. It ASSUMES no rows
   are currently in status 'done' (true whenever the manual action has not yet
   produced such rows, or after they are reconciled back to 'in_progress');
   otherwise reconcile that data first — restoring the 'done'-less enum CHECK
   while a 'done' row exists would leave a row the restored constraint rejects.

   alter table public.tasks
     drop constraint if exists tasks_done_is_human_only;

   alter table public.tasks
     drop constraint if exists tasks_status_allowed;
   alter table public.tasks
     add constraint tasks_status_allowed check (
       status in ('todo', 'in_progress', 'in_review', 'approved', 'published', 'reverted')
     );
============================================================================ */
