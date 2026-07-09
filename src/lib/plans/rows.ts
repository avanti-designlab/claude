/**
 * Pure roadmap → insert-row mapping for plan persistence (doc 03 §3, §6;
 * frozen schema: supabase/migrations/0004_plans_and_tasks.sql). No server
 * imports and no Supabase client — the onboarding write path
 * (src/lib/clients/actions.ts) feeds these rows to PostgREST, and the mapping
 * itself is unit-tested in the default `npm test` run.
 *
 * Scoping ids (tenant_id / client_id / plan_id) are pinned HERE on every row
 * from caller-supplied values that are themselves claim-sourced upstream —
 * and re-pinned below us by RLS (`plans_insert` / `tasks_insert`, migration
 * 0004), so a row can never land outside the caller's tenant.
 */

import { AUTOMATION_LEVELS, type AutomationLevel } from "@/lib/types/db";
import type {
  GeneratedRoadmap,
  ImpactLevel,
  RoadmapTask,
  TaskSource,
} from "@/lib/types/roadmap";

/** Insert shape for `plans` (migration 0004 — only the caller-set columns). */
export interface PlanInsertRow {
  tenant_id: string;
  client_id: string;
  playbook_version: string;
  generated_roadmap: GeneratedRoadmap;
}

/**
 * What rides in `tasks.payload` (jsonb): the roadmap item's details, keyed
 * exactly as the item holds them. Fields promoted to real columns (module,
 * automation_level, status) are deliberately NOT duplicated here — the column
 * is the single source of truth, and a stale jsonb copy of an automation
 * level is exactly the drift CLAUDE.md rule 5 exists to prevent.
 */
export interface TaskPayload {
  /** The item's id within plans.generated_roadmap.tasks (trace-back key). */
  id: string;
  title: string;
  description: string;
  channel: string;
  source: TaskSource;
  impact: ImpactLevel;
  priorityScore: number;
  effortWeight: number;
}

/** Insert shape for `tasks` (migration 0004 — only the caller-set columns). */
export interface TaskInsertRow {
  tenant_id: string;
  client_id: string;
  plan_id: string;
  module: string;
  automation_level: AutomationLevel;
  status: "todo";
  payload: TaskPayload;
}

/**
 * Re-pin an automation level to the frozen CHECK set
 * (`tasks_automation_level_allowed`: auto | ai_draft_human_approve |
 * human_only — doc 03 §6). The generator already clamps (audit-merge.ts), so
 * this is a belt-and-braces guard at the persistence seam: anything not in
 * the set falls to 'ai_draft_human_approve', NEVER 'auto' (CLAUDE.md rule 5 —
 * AI drafts, humans approve). 'auto' survives ONLY when the generator itself
 * emitted exactly 'auto'.
 */
export function clampAutomationLevel(level: unknown): AutomationLevel {
  return (AUTOMATION_LEVELS as readonly unknown[]).includes(level)
    ? (level as AutomationLevel)
    : "ai_draft_human_approve";
}

/** The `plans` row for a server-generated roadmap. */
export function planInsertRow(args: {
  tenantId: string;
  clientId: string;
  roadmap: GeneratedRoadmap;
}): PlanInsertRow {
  return {
    tenant_id: args.tenantId,
    client_id: args.clientId,
    // The generator copies the loaded playbook's version verbatim
    // (roadmap.playbookVersion), so the column and the stored roadmap can
    // never disagree about which playbook produced them.
    playbook_version: args.roadmap.playbookVersion,
    generated_roadmap: args.roadmap,
  };
}

/** One `tasks` row per roadmap item, in roadmap (priority) order. */
export function taskInsertRows(args: {
  tenantId: string;
  clientId: string;
  planId: string;
  roadmap: GeneratedRoadmap;
}): TaskInsertRow[] {
  return args.roadmap.tasks.map(
    (task): TaskInsertRow => ({
      tenant_id: args.tenantId,
      client_id: args.clientId,
      plan_id: args.planId,
      module: task.module,
      automation_level: clampAutomationLevel(task.automationLevel),
      status: "todo",
      payload: taskPayload(task),
    })
  );
}

function taskPayload(task: RoadmapTask): TaskPayload {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    channel: task.channel,
    source: task.source,
    impact: task.impact,
    priorityScore: task.priorityScore,
    effortWeight: task.effortWeight,
  };
}
