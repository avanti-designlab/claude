import type { Metadata } from "next";
import Link from "next/link";
import {
  ClipboardListIcon,
  FileSearchIcon,
  MapPinnedIcon,
  RadarIcon,
  SparklesIcon,
  StarIcon,
} from "lucide-react";

import { Card } from "@/components/ui/card";
import type { TaskStatus } from "@/lib/types/db";
import {
  FailedState,
  PageHeader,
  PanelCard,
} from "../../../../_components/surface";
import { tryCreateClient } from "../../../../_components/reads";

export const metadata: Metadata = {
  title: "Overview — Client workspace",
};

/**
 * Overview tab — the operator's at-a-glance summary for one client: the current
 * plan + task load (M1), and quick routes into the intelligence and local tabs.
 * Reads `plans` (latest) + `tasks` (HEAD counts) RLS-scoped; no fabricated
 * numbers.
 */

interface OverviewData {
  planVersion: string | null;
  taskTotal: number;
  taskInReview: number;
}

type Load = { ok: false } | { ok: true; data: OverviewData };

async function load(clientId: string): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const countOf = (status?: TaskStatus) => {
      let q = supabase
        .from("tasks")
        .select("id", { count: "exact", head: true })
        .eq("client_id", clientId);
      if (status) q = q.eq("status", status);
      return q;
    };
    const [planRes, totalRes, inReviewRes] = await Promise.all([
      supabase
        .from("plans")
        .select("playbook_version")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      countOf(),
      countOf("in_review"),
    ]);
    if (planRes.error) return { ok: false };
    if (totalRes.error || totalRes.count === null) return { ok: false };
    if (inReviewRes.error || inReviewRes.count === null) return { ok: false };
    return {
      ok: true,
      data: {
        planVersion:
          (planRes.data as { playbook_version: string } | null)
            ?.playbook_version ?? null,
        taskTotal: totalRes.count,
        taskInReview: inReviewRes.count,
      },
    };
  } catch {
    return { ok: false };
  }
}

const JUMP_LINKS = [
  { segment: "audit", label: "Audit", icon: FileSearchIcon, hint: "On-page & technical score" },
  { segment: "visibility", label: "Visibility", icon: SparklesIcon, hint: "AI citations & share of voice" },
  { segment: "crawler-health", label: "Crawler Health", icon: RadarIcon, hint: "AI crawler & render access" },
  { segment: "local-seo", label: "Local SEO", icon: MapPinnedIcon, hint: "NAP, schema & local pack" },
  { segment: "reviews", label: "Reviews", icon: StarIcon, hint: "Sentiment & response drafts" },
  { segment: "plan", label: "Plan", icon: ClipboardListIcon, hint: "Roadmap & tasks" },
];

export default async function OverviewTab({
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
        title="Overview"
        description="The current plan, task load, and where to dig in."
      />

      {!result.ok ? (
        <FailedState subject="this overview" />
      ) : (
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <SummaryCard
            label="Current plan"
            value={result.data.planVersion ?? "None yet"}
            mono={Boolean(result.data.planVersion)}
          />
          <SummaryCard label="Open & total tasks" value={String(result.data.taskTotal)} />
          <SummaryCard label="Awaiting review" value={String(result.data.taskInReview)} />
        </section>
      )}

      <PanelCard
        title="Jump into a module"
        description="Every intelligence and production surface for this client"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {JUMP_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <Link
                key={link.segment}
                href={`/clients/${clientId}/${link.segment}`}
                className="group flex items-center gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3 transition-colors hover:border-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
              >
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
                >
                  <Icon className="size-4 text-accent" strokeWidth={2} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-medium text-ink">{link.label}</span>
                  <span className="truncate text-xs text-muted">{link.hint}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </PanelCard>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <Card className="gap-1 px-5 py-4">
      <span className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
        {label}
      </span>
      <span
        className={
          "font-display text-2xl font-bold tracking-tight text-ink" +
          (mono ? " font-mono text-lg" : " tabular-nums")
        }
      >
        {value}
      </span>
    </Card>
  );
}
