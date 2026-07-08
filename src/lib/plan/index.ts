/**
 * Plan generator (M1, doc 02 / doc 07 §1.1).
 *
 * `generatePlan` merges a loaded playbook with an optional audit result into a
 * prioritized, channel-weighted task roadmap:
 *
 * 1. Every carrying channel in `channel_weighting` yields its archetype's
 *    starter tasks (channel-tasks.ts) — effort follows where the vertical
 *    builds authority, never an even split (doc 02).
 * 2. Audit fixes merge in as gap-closing tasks with the ×1.25 source boost
 *    (audit-merge.ts), so found gaps outrank generic starters at the same
 *    channel weight. Automation levels are clamped there per doc 03 §6.
 * 3. `channelAllocation` is each carrying channel's proportional share of the
 *    total weight — shares sum to 1.
 * 4. Tasks sort deterministically (scoring.ts): same inputs → identical roadmap.
 *
 * Pure and deterministic — the caller supplies `now`; no wall-clock, network,
 * or randomness inside.
 */

import type { Playbook } from "@/lib/types/playbook";
import type { GeneratedRoadmap, RoadmapTask } from "@/lib/types/roadmap";
import { asAuditResult, auditTasks } from "./audit-merge";
import { weightedChannels, type WeightedChannel } from "./archetypes";
import { channelFocus, playbookChannelTasks } from "./channel-tasks";
import { sortTasks } from "./scoring";

export interface GeneratePlanInput {
  playbook: Playbook;
  /** ISO timestamp for `generatedAt` (keeps the generator pure). */
  now: string;
  /** Optional audit result to merge (aeo-audit skill output). Absent = playbook-only plan. */
  audit?: unknown;
}

/** Proportional effort share per carrying channel (sums to 1 when any carry). */
function channelAllocation(channels: WeightedChannel[]): Record<string, number> {
  const totalWeight = channels.reduce((sum, c) => sum + c.weight, 0);
  const allocation: Record<string, number> = {};
  if (totalWeight <= 0) return allocation;
  for (const c of channels) allocation[c.channel] = c.weight / totalWeight;
  return allocation;
}

/**
 * One calm, specific sentence describing the plan (Content-Quality-gated —
 * no filler, no hype). Deterministic: built only from the inputs.
 */
function buildSummary(
  channels: WeightedChannel[],
  allocation: Record<string, number>,
  taskCount: number,
  auditTaskCount: number,
): string {
  if (channels.length === 0 || taskCount === 0) {
    return "No channels carry weight in this playbook yet, so there are no tasks to schedule.";
  }
  const top = channels[0];
  const topShare = Math.round((allocation[top.channel] ?? 0) * 100);
  const auditClause =
    auditTaskCount > 0
      ? `, including ${auditTaskCount} ${auditTaskCount === 1 ? "fix" : "fixes"} the audit surfaced`
      : "";
  return `This plan puts ${topShare}% of the effort into ${channelFocus(top.channel)} — ${taskCount} ${
    taskCount === 1 ? "task" : "tasks"
  } across ${channels.length} ${channels.length === 1 ? "channel" : "channels"}${auditClause}.`;
}

export function generatePlan(input: GeneratePlanInput): GeneratedRoadmap {
  const { playbook, now } = input;

  const channels = weightedChannels(playbook);
  const tasks: RoadmapTask[] = playbookChannelTasks(playbook);

  const audit = asAuditResult(input.audit);
  const mergedAuditTasks = audit ? auditTasks(audit, playbook) : [];
  tasks.push(...mergedAuditTasks);

  const allocation = channelAllocation(channels);

  return {
    vertical: playbook.vertical,
    playbookVersion: playbook.version,
    generatedAt: now,
    channelAllocation: allocation,
    tasks: sortTasks(tasks),
    summary: buildSummary(channels, allocation, tasks.length, mergedAuditTasks.length),
  };
}
