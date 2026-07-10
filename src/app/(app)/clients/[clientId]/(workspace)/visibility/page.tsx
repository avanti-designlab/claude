import type { Metadata } from "next";
import { SparklesIcon, TargetIcon, TrendingUpIcon } from "lucide-react";

import { ShareOfVoice, VisibilityTrend } from "@/components/charts";
import {
  getLatestRunResults,
  getLatestShareOfVoice,
  getLatestVisibilityScore,
  getVisibilityScoreSeries,
} from "@/lib/intelligence/visibility/reads";
import { readClientCompetitors } from "@/lib/competitors/reads";
import { toCompetitorRefs } from "@/lib/competitors/refs";
import { getClaims } from "@/lib/auth/session";
import { isStaffRole } from "@/lib/auth/parse-claims";
import type { VisibilityEngine } from "@/lib/types/db";
import {
  FailedState,
  PageHeader,
  PanelCard,
  PendingState,
  StatusPill,
} from "../../../../_components/surface";
import { tryCreateClient } from "../../../../_components/reads";
import { PromptResults } from "./_components/prompt-results";
import { CompetitorsPanel } from "./_components/competitors-panel";

export const metadata: Metadata = {
  title: "Visibility — Client workspace",
};

/**
 * Visibility tab — AI-visibility tracking (M3) + share of voice vs competitors
 * (M4). Reuses the frozen visibility reads and the F2 chart language (Recharts,
 * no signature animation — that resolve moment belongs to the client-facing
 * report). Absent data reads as pending; no invented scores.
 */

const ENGINE_LABEL: Record<VisibilityEngine, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
  claude: "Claude",
  copilot: "Copilot",
  google_aio: "Google AIO",
};

const DATE_SHORT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
function shortDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_SHORT.format(t) : "—";
}

export default async function VisibilityTab({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  const { clientId } = await params;
  const supabase = await tryCreateClient();

  // Named competitors seed the manage panel AND feed share of voice — SOV
  // measures the client against exactly the rows listed below (one source of
  // truth). The write floor is the caller's role: staff manage, a viewer reads.
  const [claims, competitorsRead] = await Promise.all([
    getClaims(),
    supabase
      ? readClientCompetitors(supabase, clientId)
      : Promise.resolve({ ok: false } as const),
  ]);
  const canManage = claims ? isStaffRole(claims.role) : false;

  const [latest, series, sov, results] = supabase
    ? await Promise.all([
        getLatestVisibilityScore(supabase, clientId),
        getVisibilityScoreSeries(supabase, clientId, { maxRuns: 30 }),
        // A FAILED competitors read routes SOV to its failed state — the chart
        // must never invent "no competitors set" out of a read blip.
        competitorsRead.ok
          ? getLatestShareOfVoice(
              supabase,
              clientId,
              toCompetitorRefs(competitorsRead.rows)
            )
          : Promise.resolve({ kind: "failed" } as const),
        getLatestRunResults(supabase, clientId),
      ])
    : [
        { kind: "failed" } as const,
        { kind: "failed" } as const,
        { kind: "failed" } as const,
        { kind: "failed" } as const,
      ];

  // Whether a stored tracker run exists — the competitors panel's footer copy
  // hangs on it: SOV recomputes against the latest STORED run at read time, so
  // once a run exists a competitor change shows on the next render (no new run
  // needed) and "waiting on tracking" would be false.
  const sovHasRun = sov.kind === "ok" && sov.latest !== null;

  const ready = latest.kind === "ok" && latest.latest !== null ? latest.latest : null;
  const cited = ready
    ? ready.engines.filter((e) => e.score !== null && e.cited > 0).length
    : 0;
  const measured = ready ? ready.engines.filter((e) => e.score !== null).length : 0;

  // Per-prompt panel: surface a read failure, render the table when a run exists,
  // and SUPPRESS the panel with no run — the "No tracker run yet" pending above
  // already stands for that (do NOT add a run button; tracking is vendor-gated).
  const promptRun =
    results.kind === "ok" && results.latest !== null ? results.latest : null;
  const promptResultsFailed = results.kind === "failed";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        level="h2"
        title="Visibility"
        description="How AI answer engines cite this client, over time, and their share of AI answers versus named competitors."
      />

      <PanelCard
        title="AI visibility"
        description="The latest tracker run across every engine"
        aside={
          ready ? (
            <StatusPill tone="accent">
              {cited} of {measured} citing
            </StatusPill>
          ) : undefined
        }
      >
        {latest.kind === "failed" ? (
          <FailedState subject="visibility" />
        ) : !ready ? (
          <PendingState
            icon={SparklesIcon}
            title="No tracker run yet"
            measuring="The tracker runs the playbook's prompt library across ChatGPT, Perplexity, Gemini, Claude, Copilot, and Google AI Overviews, then logs where the client is cited."
          />
        ) : (
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-end gap-6 rounded-lg border border-border bg-surface-raised px-5 py-4">
              <div className="flex flex-col">
                <span className="font-mono text-[10px] tracking-[0.14em] text-muted uppercase">
                  Visibility score
                </span>
                <span className="font-display text-4xl font-bold tabular-nums text-ink">
                  {ready.score}
                </span>
              </div>
              <p className="text-xs text-muted">
                Across {ready.samples} tracked answer
                {ready.samples === 1 ? "" : "s"} · updated {shortDate(ready.runAt)}
              </p>
            </div>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {ready.engines.map((e) => {
                const isCited = e.score !== null && e.cited > 0;
                return (
                  <li
                    key={e.engine}
                    className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <span className="truncate text-ink">
                      {ENGINE_LABEL[e.engine]}
                    </span>
                    <StatusPill tone={isCited ? "positive" : "muted"}>
                      {e.score === null ? "—" : isCited ? "Cited" : "Not cited"}
                    </StatusPill>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </PanelCard>

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
        <PanelCard
          title="Visibility over time"
          description="Score across tracker runs"
        >
          {series.kind === "ok" && series.series.length >= 2 ? (
            <VisibilityTrend
              data={series.series.map((run) => ({
                date: shortDate(run.runAt),
                score: run.score,
              }))}
            />
          ) : series.kind === "failed" ? (
            <FailedState subject="the trend" />
          ) : (
            <PendingState
              icon={TrendingUpIcon}
              title="Visibility trend"
              measuring="The line plots each tracker run — it draws itself once two or more runs have landed."
            />
          )}
        </PanelCard>

        <PanelCard
          title="Share of voice"
          description="This client's slice of AI answers vs named competitors"
        >
          {sov.kind === "ok" && sov.latest !== null ? (
            <ShareOfVoice
              data={[
                {
                  name: "This client",
                  share: Math.round(sov.latest.shareOfVoice.client.share * 100),
                  isClient: true,
                },
                ...sov.latest.shareOfVoice.competitors.map((c) => ({
                  name: c.name,
                  share: Math.round(c.share * 100),
                })),
              ]}
            />
          ) : sov.kind === "failed" ? (
            <FailedState subject="share of voice" />
          ) : (
            <PendingState
              icon={TargetIcon}
              title="Share of voice"
              measuring="Your share vs named competitors surfaces once tracking runs and competitors are set for this client."
            />
          )}
        </PanelCard>
      </section>

      <PanelCard
        title="Competitors"
        description="The named rivals that share of voice measures this client against — managed here, matched by domain in AI answers"
      >
        {competitorsRead.ok ? (
          <CompetitorsPanel
            clientId={clientId}
            initial={competitorsRead.rows}
            canManage={canManage}
            hasRun={sovHasRun}
          />
        ) : (
          <FailedState subject="competitors" />
        )}
      </PanelCard>

      {promptResultsFailed || promptRun ? (
        <PanelCard
          title="Per-prompt results"
          description="One row per prompt and engine from the latest run — where the client was cited, the position and sentiment when the engine reported them, and the source cited otherwise. A dash means that signal wasn't captured, not zero."
          aside={
            promptRun ? (
              <StatusPill tone="muted">
                {promptRun.rows.length}{" "}
                {promptRun.rows.length === 1 ? "sample" : "samples"}
              </StatusPill>
            ) : undefined
          }
        >
          {promptRun ? (
            <PromptResults rows={promptRun.rows} />
          ) : (
            <FailedState subject="prompt results" />
          )}
        </PanelCard>
      ) : null}
    </div>
  );
}
