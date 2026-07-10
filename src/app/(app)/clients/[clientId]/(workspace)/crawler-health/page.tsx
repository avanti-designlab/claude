import type { Metadata } from "next";
import { RadarIcon } from "lucide-react";

import { readCrawlerRenderStatus } from "@/lib/intelligence/monitoring/reads";
import {
  FailedState,
  PageHeader,
  PanelCard,
  PendingState,
  StatusPill,
} from "../../../../_components/surface";
import { tryCreateClient } from "../../../../_components/reads";

export const metadata: Metadata = {
  title: "Crawler Health — Client workspace",
};

/**
 * Crawler Health tab — AI crawler + render-visibility monitoring (M5). Reads
 * `readCrawlerRenderStatus` (RLS-scoped): open `crawler_blocked` findings for
 * the client. Unknown ≠ blocked — an empty view means nothing has been flagged,
 * not a proven all-clear, so the copy stays honest that monitoring must run.
 */

const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
function medDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

export default async function CrawlerHealthTab({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await tryCreateClient();
  const result = supabase
    ? await readCrawlerRenderStatus(supabase, clientId)
    : ({ ok: false } as const);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        level="h2"
        title="Crawler Health"
        description="Whether the major AI crawlers can reach the client's site, and whether key pages render without JavaScript — the technical half of 'why am I not cited?'"
      />

      <PanelCard
        title="Access & render checks"
        description="Blocked AI crawlers and JS-render invisibility, flagged as findings"
      >
        {!result.ok ? (
          <FailedState subject="crawler health" />
        ) : result.entries.length === 0 ? (
          <PendingState
            icon={RadarIcon}
            title="No crawler issues flagged"
            measuring="Monitoring checks GPTBot, ClaudeBot, PerplexityBot, Google-Extended, and render visibility. Findings appear here when it runs — an empty view means nothing is flagged, not a proven all-clear."
          />
        ) : (
          <ul className="flex flex-col">
            {result.entries.map((entry, i) => (
              <li
                key={entry.alertId}
                className={
                  "flex items-start justify-between gap-3 py-3" +
                  (i > 0 ? " border-t border-border" : "")
                }
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-ink">
                    {entry.summary ?? "Crawler access issue"}
                  </span>
                  <span className="truncate font-mono text-xs text-muted">
                    {entry.baseUrl ?? "—"}
                    {entry.blockedCrawlers && entry.blockedCrawlers.length > 0
                      ? ` · ${entry.blockedCrawlers.length} crawler${
                          entry.blockedCrawlers.length === 1 ? "" : "s"
                        } blocked`
                      : ""}
                    {" · "}
                    {medDate(entry.detectedAt ?? entry.createdAt)}
                  </span>
                </div>
                <StatusPill
                  tone={entry.severity === "critical" ? "negative" : "warm"}
                >
                  {entry.severity}
                </StatusPill>
              </li>
            ))}
          </ul>
        )}
      </PanelCard>
    </div>
  );
}
