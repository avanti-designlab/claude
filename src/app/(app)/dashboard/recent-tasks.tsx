import { Badge } from "@/components/ui/badge";
import { WashPill, type WashPillTone } from "@/components/dashboard-preview";
import type { AutomationLevel, TaskRow, TaskStatus } from "@/lib/types/db";

/**
 * The recent-tasks list — the beginning of the work-done log (doc 06 §5).
 * Server-safe (pure markup, RLS-scoped rows passed in by the page). Rows are
 * deliberately utilitarian — a dense log stays OUT of the entrance
 * choreography and carries no glow; the tone pills are the only color.
 */

/** The columns the dashboard reads per recent task (+ resolved client name). */
export type RecentTask = Pick<
  TaskRow,
  "id" | "client_id" | "module" | "automation_level" | "status" | "created_at"
> & { clientName: string };

/** doc 03 §6 levels, spelled out — the flag is a promise about human review. */
const AUTOMATION_LABEL: Record<AutomationLevel, string> = {
  auto: "auto",
  ai_draft_human_approve: "AI draft · human approve",
  human_only: "human only",
};

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  approved: "Approved",
  published: "Published",
  reverted: "Reverted",
};

/**
 * Status tones (semantic, never brand-decorative): working stages ride the
 * accent blue, "in review" wears the warm attention gold (it needs a human),
 * approved/published are positive, reverted is negative.
 */
const TASK_STATUS_TONE: Record<TaskStatus, WashPillTone> = {
  todo: "blue",
  in_progress: "blue",
  in_review: "gold",
  approved: "positive",
  published: "positive",
  reverted: "negative",
};

/** Deterministic short date ("Jul 9") — server-rendered, locale-pinned. */
function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function RecentTaskList({ tasks }: { tasks: RecentTask[] }) {
  return (
    <ul className="flex flex-col divide-y divide-border">
      {tasks.map((task) => (
        <li
          key={task.id}
          className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3 first:pt-0 last:pb-0"
        >
          <div className="flex min-w-0 flex-1 basis-48 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] tracking-wide text-accent uppercase">
                {task.module}
              </span>
              <Badge
                variant="outline"
                className="font-mono text-[10px] uppercase"
              >
                {AUTOMATION_LABEL[task.automation_level]}
              </Badge>
            </div>
            <span className="truncate text-sm text-ink">{task.clientName}</span>
          </div>
          <WashPill tone={TASK_STATUS_TONE[task.status]} className="shrink-0">
            {TASK_STATUS_LABEL[task.status]}
          </WashPill>
          <span className="shrink-0 font-mono text-xs text-muted">
            {shortDate(task.created_at)}
          </span>
        </li>
      ))}
    </ul>
  );
}
