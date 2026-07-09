import type { LucideIcon } from "lucide-react";
import {
  BotIcon,
  CalendarClockIcon,
  CodeXmlIcon,
  FileTextIcon,
  MapPinnedIcon,
  MessageSquareWarningIcon,
  RadarIcon,
  ServerCrashIcon,
  SparklesIcon,
  TargetIcon,
  TrendingDownIcon,
  TrendingUpIcon,
  Undo2Icon,
  UsersRoundIcon,
  WrenchIcon,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AlertsList,
  type AlertItem,
  type AlertTone,
  GlowCard,
  WashPill,
} from "@/components/dashboard-preview";
import {
  type EngineDot,
  VisibilityScoreResolve,
} from "@/components/moments";
import { VisibilityTrend, ShareOfVoice } from "@/components/charts";
import type { CitationStatus } from "@/components/charts/engine-citations";
import type {
  AlertSeverity,
  AlertType,
  ContentItemStatus,
  ContentItemType,
  SiteChangeType,
  VisibilityEngine,
} from "@/lib/types/db";
import type { LatestShareOfVoice } from "@/lib/intelligence/visibility/reads";
import type { LocalHistoryEntry } from "@/lib/local/rows";
import type { ActiveAlertEntry } from "@/lib/alerting/rows";
import type {
  ContentCalendarPanel,
  PanelState,
  RoiPanel,
  VisibilityPanel,
  WorkLogEvent,
} from "./load";

/* ------------------------------------------------------------------ */
/* Shared formatting                                                   */
/* ------------------------------------------------------------------ */

const DATE_SHORT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});
const DATE_MED = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function shortDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_SHORT.format(t) : "—";
}
function medDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_MED.format(t) : "—";
}

/** Section title — the operator dashboard's display-face treatment. */
export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <CardTitle className="font-display text-2xl leading-tight font-bold tracking-tight">
      {children}
    </CardTitle>
  );
}

/**
 * The shared honest PENDING state — a module whose real data source isn't
 * connected yet. Quiet by design (dashed, muted, no glow): a pending panel
 * never competes with real data, and it never shows a fabricated number. The
 * copy names what has to connect, in the interface voice (doc 06 §6).
 */
export function PendingPanel({
  icon: Icon = RadarIcon,
  title,
  measuring,
}: {
  icon?: LucideIcon;
  title: string;
  measuring: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full bg-overlay"
      >
        <Icon className="size-5 text-muted" strokeWidth={1.75} />
      </span>
      <div className="flex flex-col items-center gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{title}</span>
          <WashPill tone="gold">Measuring soon</WashPill>
        </div>
        <p className="max-w-xs text-xs leading-5 text-muted">{measuring}</p>
      </div>
    </div>
  );
}

/** A read failed (retryable) — honest, and never mistaken for "no data". */
export function FailedPanel({ title }: { title: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink">
        Couldn&apos;t load {title.toLowerCase()}
      </p>
      <p className="max-w-xs text-xs leading-5 text-muted">
        This is a temporary read issue, not a data problem — refresh to try
        again.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Visibility Score — THE signature moment (moment #2)                 */
/* ------------------------------------------------------------------ */

const ENGINE_LABEL: Record<VisibilityEngine, string> = {
  chatgpt: "ChatGPT",
  perplexity: "Perplexity",
  gemini: "Gemini",
  claude: "Claude",
  copilot: "Copilot",
  google_aio: "Google AIO",
};

/** Engine breakdown → the moment's settling dots. Absent (score null) and
 *  measured-but-uncited both read "not cited"; a cited engine reads "cited".
 *  We never invent a "lost" verdict — that needs a run-over-run comparison the
 *  headline read doesn't carry. */
function toEngineDots(
  engines: VisibilityPanel["latest"]["engines"],
): EngineDot[] {
  return engines.map((e) => {
    const status: CitationStatus =
      e.score !== null && e.cited > 0 ? "cited" : "missing";
    return { engine: ENGINE_LABEL[e.engine], status };
  });
}

/**
 * The white-label hero: the tenant's brand frame (GlowCard) around the frozen
 * Visibility Score "resolve" moment. The moment sits on a raised inner panel so
 * its ink/muted tokens read correctly regardless of the glow fill — the score
 * resolves out of noise and the per-engine dots settle (doc 06 §2/§4.2). Under
 * reduced motion the moment renders its final state instantly (its own gate).
 */
export function VisibilityHero({
  clientName,
  vertical,
  brandName,
  panel,
}: {
  clientName: string;
  vertical: string;
  brandName: string;
  panel: PanelState<VisibilityPanel>;
}) {
  const ready = panel.state === "ready" ? panel.data : null;
  const cited =
    ready?.latest.engines.filter((e) => e.score !== null && e.cited > 0)
      .length ?? 0;
  const measured =
    ready?.latest.engines.filter((e) => e.score !== null).length ?? 0;

  return (
    <GlowCard surface="hero" scale="hero" bloom>
      <section className="grid gap-8 p-7 sm:p-9 lg:grid-cols-[1fr_auto] lg:items-center lg:p-11">
        <div className="flex flex-col gap-5 text-accent-foreground dark:text-ink">
          <span className="font-mono text-[11px] tracking-[0.2em] uppercase text-accent-foreground/70 dark:text-muted">
            {brandName} · AI visibility report
          </span>
          <div className="flex flex-col gap-2">
            <h1 className="font-display text-display leading-[0.95] font-bold tracking-[-0.02em] sm:text-hero">
              {clientName}
            </h1>
            <p className="text-base text-accent-foreground/85 dark:text-ink/85">
              How AI answer engines cite you — and the work moving it.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center rounded-full border border-accent-foreground/25 bg-accent-foreground/12 px-2.5 py-0.5 font-mono text-[10px] tracking-wide uppercase dark:border-ink/20 dark:bg-ink/8">
              {vertical}
            </span>
            {ready ? (
              <span className="inline-flex items-center rounded-full border border-accent-foreground/25 bg-accent-foreground/12 px-2.5 py-0.5 font-mono text-[10px] tracking-wide uppercase dark:border-ink/20 dark:bg-ink/8">
                {cited} of {measured} engines citing
              </span>
            ) : null}
          </div>
        </div>

        {/* Raised readout panel — correct contrast for the ink/muted moment. */}
        <div className="flex justify-center rounded-[calc(var(--radius)*3)] bg-surface-raised/95 p-6 shadow-lg backdrop-blur-sm sm:p-7 lg:justify-end">
          {ready ? (
            <VisibilityScoreResolve
              score={ready.latest.score}
              engines={toEngineDots(ready.latest.engines)}
              caption={`Across ${ready.latest.samples} tracked answer${
                ready.latest.samples === 1 ? "" : "s"
              } · updated ${shortDate(ready.latest.runAt)}`}
              className="w-full max-w-xs"
            />
          ) : panel.state === "failed" ? (
            <div className="w-full max-w-xs">
              <FailedPanel title="Visibility Score" />
            </div>
          ) : (
            <PendingVisibility />
          )}
        </div>
      </section>
    </GlowCard>
  );
}

/** The hero's honest pending state — a dashed resolve ring in the client voice. */
function PendingVisibility() {
  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-3 py-2 text-center">
      <span
        aria-hidden
        className="flex size-32 items-center justify-center rounded-full border-2 border-dashed border-border sm:size-36"
      >
        <RadarIcon className="size-8 text-muted" strokeWidth={1.5} />
      </span>
      <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-muted">
        Visibility Score
      </p>
      <p className="text-xs leading-5 text-muted">
        Your score resolves here the first time AI-visibility tracking runs for
        your site.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Visibility trend                                                    */
/* ------------------------------------------------------------------ */

export function TrendPanel({ panel }: { panel: PanelState<VisibilityPanel> }) {
  return (
    <PanelCard
      title="Visibility over time"
      description="Your AI-visibility score across tracker runs"
    >
      {panel.state === "ready" ? (
        panel.data.series.length >= 2 ? (
          <VisibilityTrend
            data={panel.data.series.map((run) => ({
              date: shortDate(run.runAt),
              score: run.score,
            }))}
          />
        ) : (
          <div className="flex items-center gap-3 rounded-lg border border-dashed border-border px-5 py-8 text-sm text-muted">
            <TrendingUpIcon className="size-5 shrink-0" strokeWidth={1.75} />
            <span>
              One run so far — the trend line draws itself as more tracker runs
              land.
            </span>
          </div>
        )
      ) : panel.state === "failed" ? (
        <FailedPanel title="the trend" />
      ) : (
        <PendingPanel
          icon={TrendingUpIcon}
          title="Visibility trend"
          measuring="The line plots each tracker run once AI-visibility tracking is connected."
        />
      )}
    </PanelCard>
  );
}

/* ------------------------------------------------------------------ */
/* Share of voice                                                      */
/* ------------------------------------------------------------------ */

export function ShareOfVoicePanel({
  clientName,
  panel,
}: {
  clientName: string;
  panel: PanelState<LatestShareOfVoice>;
}) {
  return (
    <PanelCard
      title="Share of voice"
      description="Your slice of AI answers vs named competitors"
    >
      {panel.state === "ready" ? (
        <ShareOfVoice
          data={[
            {
              name: clientName,
              share: Math.round(panel.data.shareOfVoice.client.share * 100),
              isClient: true,
            },
            ...panel.data.shareOfVoice.competitors.map((c) => ({
              name: c.name,
              share: Math.round(c.share * 100),
            })),
          ]}
        />
      ) : panel.state === "failed" ? (
        <FailedPanel title="share of voice" />
      ) : (
        <PendingPanel
          icon={TargetIcon}
          title="Share of voice"
          measuring="Your share vs named competitors surfaces once tracking runs and competitors are set."
        />
      )}
    </PanelCard>
  );
}

/* ------------------------------------------------------------------ */
/* Local rankings                                                      */
/* ------------------------------------------------------------------ */

export function LocalRankingsPanel({
  panel,
}: {
  panel: PanelState<LocalHistoryEntry[]>;
}) {
  return (
    <PanelCard
      title="Local presence"
      description="Local readiness across your locations"
    >
      {panel.state === "ready" ? (
        <ul className="flex flex-col">
          {panel.data.slice(0, 6).map((entry, i) => (
            <li
              key={entry.id}
              className={
                "flex items-center justify-between gap-3 py-3" +
                (i > 0 ? " border-t border-border" : "")
              }
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
                >
                  <MapPinnedIcon className="size-4 text-accent" strokeWidth={2} />
                </span>
                <div className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">
                    {entry.assessedLocations ?? 0} of {entry.totalLocations ?? 0}{" "}
                    locations assessed
                  </span>
                  <span className="block font-mono text-xs text-muted">
                    {medDate(entry.createdAt)}
                    {entry.fixCount ? ` · ${entry.fixCount} fixes queued` : ""}
                  </span>
                </div>
              </div>
              <span className="shrink-0 font-display text-xl font-bold tabular-nums text-ink">
                {entry.overallScore === null ? "—" : entry.overallScore}
              </span>
            </li>
          ))}
        </ul>
      ) : panel.state === "failed" ? (
        <FailedPanel title="local presence" />
      ) : (
        <PendingPanel
          icon={MapPinnedIcon}
          title="Local presence"
          measuring="Per-location NAP, schema, and local-pack readiness appear after your first local assessment."
        />
      )}
    </PanelCard>
  );
}

/* ------------------------------------------------------------------ */
/* Work-done log — the retention weapon                                */
/* ------------------------------------------------------------------ */

const SITE_CHANGE_NOUN: Record<SiteChangeType, string> = {
  h1: "H1 heading",
  title: "page title",
  meta: "meta description",
  schema: "structured data",
  alt: "image alt text",
  content: "on-page content",
  canonical: "canonical tag",
};

const CONTENT_NOUN: Record<ContentItemType, string> = {
  blog: "blog post",
  faq: "FAQ",
  caption: "social caption",
  pillar: "pillar page",
  schema_copy: "schema copy",
};

function workLine(event: WorkLogEvent): { icon: LucideIcon; text: string; tone: AlertTone } {
  switch (event.kind) {
    case "site_change_applied":
      return {
        icon: WrenchIcon,
        text: `Applied a ${SITE_CHANGE_NOUN[event.subject as SiteChangeType] ?? "site"} update`,
        tone: "positive",
      };
    case "site_change_reverted":
      return {
        icon: Undo2Icon,
        text: `Reverted a ${SITE_CHANGE_NOUN[event.subject as SiteChangeType] ?? "site"} change`,
        tone: "warm",
      };
    case "content_published":
      return {
        icon: FileTextIcon,
        text: `Published a ${CONTENT_NOUN[event.subject as ContentItemType] ?? "piece of content"}`,
        tone: "accent",
      };
  }
}

const WORK_TONE_WELL: Record<AlertTone, { well: string; icon: string }> = {
  accent: { well: "color-mix(in oklab, var(--accent) 12%, transparent)", icon: "text-accent" },
  positive: { well: "color-mix(in oklab, var(--positive) 14%, transparent)", icon: "text-positive" },
  negative: { well: "color-mix(in oklab, var(--negative) 14%, transparent)", icon: "text-negative" },
  warm: { well: "color-mix(in oklab, var(--accent-warm) 16%, transparent)", icon: "text-accent-warm" },
};

export function WorkLogPanel({
  panel,
}: {
  panel: PanelState<WorkLogEvent[]>;
}) {
  return (
    <PanelCard
      title="What we did for you"
      description="Every change we applied and every piece we published"
    >
      {panel.state === "ready" ? (
        <ul className="flex flex-col">
          {panel.data.map((event, i) => {
            const line = workLine(event);
            const tone = WORK_TONE_WELL[line.tone];
            const Icon = line.icon;
            return (
              <li
                key={event.id}
                className={
                  "flex items-center gap-3 py-3" +
                  (i > 0 ? " border-t border-border" : "")
                }
              >
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-full"
                  style={{ background: tone.well }}
                >
                  <Icon className={"size-4 " + tone.icon} strokeWidth={2} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">
                    {line.text}
                  </span>
                  <span className="block font-mono text-xs text-muted">
                    {medDate(event.at)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      ) : panel.state === "failed" ? (
        <FailedPanel title="the work log" />
      ) : (
        <PendingPanel
          icon={WrenchIcon}
          title="Work log"
          measuring="Every applied change and published piece lands here as the team ships work — with dates and rollbacks."
        />
      )}
    </PanelCard>
  );
}

/* ------------------------------------------------------------------ */
/* Content calendar                                                    */
/* ------------------------------------------------------------------ */

const CONTENT_STATUS_LABEL: Record<ContentItemStatus, string> = {
  draft: "Drafting",
  in_review: "In review",
  approved: "Approved",
  published: "Published",
};

const CONTENT_STATUS_ORDER: ContentItemStatus[] = [
  "draft",
  "in_review",
  "approved",
  "published",
];

export function ContentCalendarPanelView({
  panel,
}: {
  panel: PanelState<ContentCalendarPanel>;
}) {
  return (
    <PanelCard
      title="Content calendar"
      description="Where every piece sits in the pipeline"
    >
      {panel.state === "ready" ? (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {CONTENT_STATUS_ORDER.map((status) => (
              <div
                key={status}
                className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised px-4 py-3"
              >
                <span className="font-display text-2xl font-bold tabular-nums text-ink">
                  {panel.data.byStatus[status]}
                </span>
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                  {CONTENT_STATUS_LABEL[status]}
                </span>
              </div>
            ))}
          </div>
          <ul className="flex flex-col">
            {panel.data.recent.map((item, i) => (
              <li
                key={item.id}
                className={
                  "flex items-center justify-between gap-3 py-2.5" +
                  (i > 0 ? " border-t border-border" : "")
                }
              >
                <span className="min-w-0 truncate text-sm text-ink">
                  {CONTENT_NOUN[item.type] ?? item.type}
                </span>
                <div className="flex shrink-0 items-center gap-3">
                  <Badge variant="secondary" className="font-mono text-[10px] uppercase">
                    {CONTENT_STATUS_LABEL[item.status]}
                  </Badge>
                  <span className="font-mono text-xs text-muted">
                    {shortDate(item.updatedAt)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs leading-5 text-muted">
            Scheduled publish dates arrive with the social content queue — for
            now this shows live pipeline status.
          </p>
        </div>
      ) : panel.state === "failed" ? (
        <FailedPanel title="the content calendar" />
      ) : (
        <PendingPanel
          icon={CalendarClockIcon}
          title="Content calendar"
          measuring="Drafts, reviews, and published pieces appear here as your content pipeline runs."
        />
      )}
    </PanelCard>
  );
}

/* ------------------------------------------------------------------ */
/* ROI                                                                 */
/* ------------------------------------------------------------------ */

const METRIC_LABEL: Record<string, string> = {
  sessions: "Sessions",
  engaged_sessions: "Engaged sessions",
  conversions: "Conversions",
  clicks: "Search clicks",
  impressions: "Impressions",
  calls: "Calls",
  form_submissions: "Form fills",
  qualified_leads: "Qualified leads",
  revenue: "Revenue",
};

const NUM = new Intl.NumberFormat("en-US");

export function RoiPanelView({ panel }: { panel: PanelState<RoiPanel> }) {
  return (
    <PanelCard
      title="Results & ROI"
      description="Measured outcomes over your latest reporting window"
    >
      {panel.state === "ready" ? (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {panel.data.snapshot.summary.metrics.map((m) => (
              <div
                key={m.metric}
                className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised px-4 py-3"
              >
                <span className="font-display text-2xl font-bold tabular-nums text-ink">
                  {NUM.format(m.value)}
                </span>
                <span className="font-mono text-[10px] tracking-[0.14em] uppercase text-muted">
                  {METRIC_LABEL[m.metric] ?? m.metric}
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs leading-5 text-muted">
            Window {medDate(panel.data.snapshot.period.start)} –{" "}
            {medDate(panel.data.snapshot.period.end)}.{" "}
            {panel.data.attribution?.roi
              ? `Attributed value $${NUM.format(
                  Math.round(panel.data.attribution.roi.attributedValue),
                )} (correlation, not causation).`
              : "A revenue value activates once your lead and deal values are set."}
          </p>
        </div>
      ) : panel.state === "failed" ? (
        <FailedPanel title="results & ROI" />
      ) : (
        <PendingPanel
          icon={TrendingUpIcon}
          title="Results & ROI"
          measuring="Sessions, calls, clicks, and conversions appear once analytics (GA4, Search Console, call tracking) are connected."
        />
      )}
    </PanelCard>
  );
}

/* ------------------------------------------------------------------ */
/* Alerts                                                              */
/* ------------------------------------------------------------------ */

const ALERT_META: Record<AlertType, { label: string; icon: LucideIcon }> = {
  visibility_drop: { label: "Visibility dropped", icon: TrendingDownIcon },
  competitor_overtook: { label: "A competitor overtook you", icon: UsersRoundIcon },
  schema_broke: { label: "Structured data broke", icon: CodeXmlIcon },
  crawler_blocked: { label: "A crawler was blocked", icon: BotIcon },
  negative_review_spike: { label: "Negative review spike", icon: MessageSquareWarningIcon },
  site_down: { label: "Site unreachable", icon: ServerCrashIcon },
  auto_rollback_fired: { label: "A change auto-rolled back", icon: Undo2Icon },
};

const SEVERITY_TONE: Record<AlertSeverity, AlertTone> = {
  critical: "negative",
  warning: "warm",
  info: "accent",
};

function toAlertItem(entry: ActiveAlertEntry): AlertItem {
  const meta = entry.type ? ALERT_META[entry.type] : null;
  return {
    icon: meta?.icon ?? SparklesIcon,
    title: meta?.label ?? "Alert",
    meta:
      entry.summary ??
      (entry.detectedAt ? medDate(entry.detectedAt) : medDate(entry.createdAt)),
    tone: entry.severity ? SEVERITY_TONE[entry.severity] : "accent",
  };
}

export function AlertsPanel({
  panel,
}: {
  panel: PanelState<ActiveAlertEntry[]>;
}) {
  const items = panel.state === "ready" ? panel.data.map(toAlertItem) : [];
  return (
    <PanelCard title="Alerts" description="Anything that needs a look">
      {panel.state === "failed" ? (
        <FailedPanel title="alerts" />
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
          <span
            aria-hidden
            className="flex size-11 items-center justify-center rounded-full bg-overlay"
          >
            <SparklesIcon className="size-5 text-muted" strokeWidth={1.75} />
          </span>
          <p className="text-sm font-medium text-ink">No open alerts</p>
          <p className="max-w-xs text-xs leading-5 text-muted">
            We surface issues here the moment monitoring catches one — an empty
            list means nothing is flagged right now.
          </p>
        </div>
      ) : (
        <AlertsList items={items} />
      )}
    </PanelCard>
  );
}

/* ------------------------------------------------------------------ */
/* Card shell                                                          */
/* ------------------------------------------------------------------ */

export function PanelCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <SectionTitle>{title}</SectionTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
