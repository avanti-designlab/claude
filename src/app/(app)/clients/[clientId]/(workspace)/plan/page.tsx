import type { Metadata } from "next";
import { ClipboardListIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AutomationLevel, TaskStatus } from "@/lib/types/db";
import {
  FailedState,
  PageHeader,
  PanelCard,
  PendingState,
  StatusPill,
} from "../../../../_components/surface";
import { tryCreateClient } from "../../../../_components/reads";

export const metadata: Metadata = {
  title: "Plan — Client workspace",
};

/**
 * Plan tab — the playbook-driven roadmap (M1). Reads the latest `plans` row +
 * the client's `tasks` (RLS-scoped). Every task carries its automation_level
 * (auto / ai-draft-human-approve / human-only) — the guarantee that nothing
 * publishes without a human when it should not.
 */

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  approved: "Approved",
  published: "Published",
  reverted: "Reverted",
};

const AUTOMATION_LABEL: Record<AutomationLevel, string> = {
  auto: "Auto",
  ai_draft_human_approve: "AI draft · you approve",
  human_only: "Human only",
};

interface TaskEntry {
  id: string;
  module: string;
  automationLevel: AutomationLevel;
  status: TaskStatus;
}

interface PlanData {
  version: string | null;
  createdAt: string | null;
  tasks: TaskEntry[];
}

type Load = { ok: false } | { ok: true; data: PlanData };

async function load(clientId: string): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const [planRes, tasksRes] = await Promise.all([
      supabase
        .from("plans")
        .select("playbook_version, created_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("tasks")
        .select("id, module, automation_level, status, created_at")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .limit(60),
    ]);
    if (planRes.error || tasksRes.error || !tasksRes.data) return { ok: false };
    const plan = planRes.data as {
      playbook_version: string;
      created_at: string;
    } | null;
    const tasks: TaskEntry[] = (
      tasksRes.data as Array<{
        id: string;
        module: string;
        automation_level: AutomationLevel;
        status: TaskStatus;
      }>
    ).map((r) => ({
      id: r.id,
      module: r.module,
      automationLevel: r.automation_level,
      status: r.status,
    }));
    return {
      ok: true,
      data: {
        version: plan?.playbook_version ?? null,
        createdAt: plan?.created_at ?? null,
        tasks,
      },
    };
  } catch {
    return { ok: false };
  }
}

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export default async function PlanTab({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const result = await load(clientId);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        level="h2"
        title="Plan"
        description="The playbook-driven roadmap — prioritized tasks, each with how much a human stays in the loop."
      />

      <PanelCard
        title="Roadmap"
        description="Tasks generated from the client's playbook and audit"
        aside={
          result.ok && result.data.version ? (
            <StatusPill tone="accent">Playbook {result.data.version}</StatusPill>
          ) : undefined
        }
      >
        {!result.ok ? (
          <FailedState subject="the plan" />
        ) : result.data.tasks.length === 0 ? (
          <PendingState
            icon={ClipboardListIcon}
            title="No tasks yet"
            measuring="A plan generates its task roadmap the moment this client's industry playbook is live — pick the industry during onboarding and the roadmap lands here."
          />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Task area</TableHead>
                  <TableHead>Automation</TableHead>
                  <TableHead className="text-right">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.tasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="font-medium text-ink capitalize">
                      {task.module}
                    </TableCell>
                    <TableCell className="text-muted">
                      {AUTOMATION_LABEL[task.automationLevel]}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant="secondary"
                        className="font-mono text-[10px] uppercase"
                      >
                        {STATUS_LABEL[task.status]}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PanelCard>

      {result.ok && result.data.createdAt ? (
        <p className="text-xs text-muted">
          Plan generated {DATE_MED.format(Date.parse(result.data.createdAt))}.
        </p>
      ) : null}
    </div>
  );
}
