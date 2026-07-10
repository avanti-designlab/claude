import type { Metadata } from "next";
import Link from "next/link";
import {
  BellRingIcon,
  BotIcon,
  CodeXmlIcon,
  type LucideIcon,
  MessageSquareWarningIcon,
  ServerCrashIcon,
  TrendingDownIcon,
  Undo2Icon,
  UsersRoundIcon,
} from "lucide-react";

import { Entrance } from "@/components/moments";
import type { AlertSeverity, AlertType } from "@/lib/types/db";
import {
  EmptyState,
  FailedState,
  PageContainer,
  PageHeader,
  PanelCard,
  StatusPill,
} from "../../_components/surface";
import { resolveClientNames, tryCreateClient } from "../../_components/reads";

export const metadata: Metadata = {
  title: "Alerts — AEO/GEO + Brand Production OS",
  description: "Everything across your clients that needs a look.",
};

/**
 * Alerts (global) — the tenant-wide operator feed. Reads the `alerts` table
 * RLS-scoped (all of the caller's clients, open alerts only, newest first);
 * app code writes no tenant filter — the database is the boundary. Alerts
 * record PROBLEMS only, so an empty feed is an honest "nothing flagged", never
 * an all-clear metric. Most monitoring sources aren't connected yet, so the
 * feed is empty today by design.
 */

const ALERT_META: Record<AlertType, { label: string; icon: LucideIcon }> = {
  visibility_drop: { label: "Visibility dropped", icon: TrendingDownIcon },
  competitor_overtook: {
    label: "A competitor overtook you",
    icon: UsersRoundIcon,
  },
  schema_broke: { label: "Structured data broke", icon: CodeXmlIcon },
  crawler_blocked: { label: "A crawler was blocked", icon: BotIcon },
  negative_review_spike: {
    label: "Negative review spike",
    icon: MessageSquareWarningIcon,
  },
  site_down: { label: "Site unreachable", icon: ServerCrashIcon },
  auto_rollback_fired: { label: "A change auto-rolled back", icon: Undo2Icon },
};

const SEVERITY_TONE: Record<AlertSeverity, "accent" | "warm" | "negative"> = {
  info: "accent",
  warning: "warm",
  critical: "negative",
};

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
function medDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

interface AlertEntry {
  id: string;
  clientId: string;
  type: AlertType;
  severity: AlertSeverity;
  createdAt: string;
}

interface AlertRawRow {
  id: string;
  client_id: string;
  type: AlertType;
  severity: AlertSeverity;
  created_at: string;
}

type Load =
  | { ok: false }
  | { ok: true; alerts: AlertEntry[]; names: Map<string, string> };

async function load(): Promise<Load> {
  const supabase = await tryCreateClient();
  if (!supabase) return { ok: false };
  try {
    const { data, error } = await supabase
      .from("alerts")
      .select("id, client_id, type, severity, created_at")
      .eq("acknowledged", false)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error || !data) return { ok: false };
    const alerts: AlertEntry[] = (data as AlertRawRow[]).map((row) => ({
      id: row.id,
      clientId: row.client_id,
      type: row.type,
      severity: row.severity,
      createdAt: row.created_at,
    }));
    const names = await resolveClientNames(
      supabase,
      alerts.map((a) => a.clientId),
    );
    return { ok: true, alerts, names };
  } catch {
    return { ok: false };
  }
}

export default async function AlertsPage() {
  const result = await load();

  return (
    <PageContainer>
      <Entrance step={0}>
        <PageHeader
          eyebrow="Operations"
          title="Alerts"
          description="Visibility drops, competitor overtakes, broken schema, blocked crawlers, review spikes, and auto-rollbacks — across every client, newest first."
        />
      </Entrance>
      <Entrance step={1}>
        <PanelCard
          title="Open alerts"
          description="Only unresolved issues — an empty list means nothing is flagged right now"
        >
          {!result.ok ? (
            <FailedState subject="alerts" />
          ) : result.alerts.length === 0 ? (
            <EmptyState
              icon={BellRingIcon}
              title="No open alerts"
              description="We surface issues here the moment monitoring catches one. Nothing is flagged across your clients right now."
            />
          ) : (
            <ul className="flex flex-col">
              {result.alerts.map((alert, i) => {
                const meta = ALERT_META[alert.type];
                const Icon = meta.icon;
                const name =
                  result.names.get(alert.clientId) ?? "A client";
                return (
                  <li
                    key={alert.id}
                    className={
                      "flex items-center gap-3 py-3" +
                      (i > 0 ? " border-t border-border" : "")
                    }
                  >
                    <span
                      aria-hidden
                      className="flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
                    >
                      <Icon className="size-4 text-muted" strokeWidth={2} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-ink">
                        {meta.label}
                      </span>
                      <span className="block font-mono text-xs text-muted">
                        <Link
                          href={`/clients/${alert.clientId}`}
                          className="underline-offset-4 hover:text-ink hover:underline"
                        >
                          {name}
                        </Link>{" "}
                        · {medDate(alert.createdAt)}
                      </span>
                    </div>
                    <StatusPill tone={SEVERITY_TONE[alert.severity]}>
                      {alert.severity}
                    </StatusPill>
                  </li>
                );
              })}
            </ul>
          )}
        </PanelCard>
      </Entrance>
    </PageContainer>
  );
}
