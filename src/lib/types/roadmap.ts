/**
 * Generated-roadmap contract (M1 Playbook Engine output — doc 02, doc 07 §1.1).
 *
 * The plan generator merges a loaded Playbook with an optional audit result
 * into a prioritized, channel-weighted task roadmap. This is the shape stored
 * in `plans.generated_roadmap` (doc 03) and rendered by the onboarding flow.
 *
 * Shared seam: the aeo-seo-logic-engineer produces it (`@/lib/plan`); the
 * frontend onboarding flow consumes it. Owned here (orchestrator) so both
 * sides build against one contract.
 */

import type { AutomationLevel } from "@/lib/types/db";
import type { Vertical } from "@/lib/types/playbook";

/** Owning module for a task (doc 00 module map / doc 05 module→agent map). */
export type ModuleRef =
  | "M2" // audit
  | "M3" // visibility tracker
  | "M4" // competitor reverse-engineering
  | "M5" // crawler/render monitoring
  | "M6" // freshness
  | "M8" // content production
  | "M10" // schema
  | "M11" // social
  | "M12" // PR entity-leverage
  | "M14" // local SEO
  | "M15"; // review management

export type ImpactLevel = "critical" | "high" | "medium" | "low";

/** Where the task came from: the playbook's plan, or a gap the audit found. */
export type TaskSource = "playbook" | "audit";

export interface RoadmapTask {
  id: string;
  /** Short, human, action-first — "Add FAQPage schema to neighborhood guides". */
  title: string;
  /** The specific instruction ("they win because X; do Y"). Content-Quality-gated text. */
  description: string;
  module: ModuleRef;
  /** Which playbook channel this builds authority in (matches a channel_weighting key). */
  channel: string;
  source: TaskSource;
  impact: ImpactLevel;
  /** Higher runs first. Deterministic; drives roadmap order. */
  priorityScore: number;
  /** Relative effort (1 = light … 5 = heavy). */
  effortWeight: number;
  /** How this task may be executed (doc 03 §6). Anything that publishes = ai_draft_human_approve. */
  automationLevel: AutomationLevel;
}

export interface GeneratedRoadmap {
  vertical: Vertical;
  playbookVersion: string;
  /** ISO timestamp, supplied by the caller (the generator stays pure/deterministic). */
  generatedAt: string;
  /** Effort share per channel (0–1), derived from the playbook's channel_weighting over active tasks. */
  channelAllocation: Record<string, number>;
  /** Ordered by priorityScore desc; deterministic tiebreak. */
  tasks: RoadmapTask[];
  /** Short human-readable plan summary (Content-Quality-gated). */
  summary: string;
}
