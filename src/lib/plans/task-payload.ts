/**
 * Read-side parser for a `tasks.payload` jsonb (doc 03 §3). The WRITE side
 * (rows.ts `TaskPayload`) is what the plan generator stores; this reads it back
 * for display, HONESTLY: a field that isn't present (or is malformed) comes back
 * `null`, never a fabricated zero or empty string. Absent ≠ zero — an unknown
 * effort is not "effort 0", and a task with no stored description shows nothing
 * rather than a blank line pretending to be its detail.
 *
 * Pure + side-effect-free (no server imports) → unit-tested in the default
 * `npm test` run.
 *
 * `priorityScore` is deliberately NOT surfaced: it is the generator's internal
 * deterministic sort key, not a human signal (same posture as the audit fix
 * list, which never renders priorityScore/checkId). The human priority band is
 * `impact`; that is what the UI shows.
 */

import type { ImpactLevel, TaskSource } from "@/lib/types/roadmap";

/** What the plan tab renders from a task's payload; every field is honestly optional. */
export interface TaskDetail {
  /** Human, action-first task name ("Add FAQPage schema to neighborhood guides"). */
  title: string | null;
  /** The specific instruction — the expandable detail's body. */
  description: string | null;
  /** Playbook channel this task builds authority in. */
  channel: string | null;
  /** Human priority band (critical | high | medium | low); null when absent. */
  impact: ImpactLevel | null;
  /** Relative effort 1 (light) … 5 (heavy); null when absent — never coerced to 0. */
  effortWeight: number | null;
  /** Whether the task came from the playbook or from an audit gap. */
  source: TaskSource | null;
}

const IMPACTS: readonly ImpactLevel[] = ["critical", "high", "medium", "low"];
const SOURCES: readonly TaskSource[] = ["playbook", "audit"];

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

/**
 * Effort weight, honestly: a finite positive number only. `0`, negatives,
 * NaN/Infinity, and non-numbers all read as "not set" (null), so the UI never
 * claims an effort the payload doesn't carry.
 */
function effort(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export function readTaskDetail(payload: unknown): TaskDetail {
  const p =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return {
    title: trimmedString(p.title),
    description: trimmedString(p.description),
    channel: trimmedString(p.channel),
    impact: IMPACTS.includes(p.impact as ImpactLevel)
      ? (p.impact as ImpactLevel)
      : null,
    effortWeight: effort(p.effortWeight),
    source: SOURCES.includes(p.source as TaskSource)
      ? (p.source as TaskSource)
      : null,
  };
}
