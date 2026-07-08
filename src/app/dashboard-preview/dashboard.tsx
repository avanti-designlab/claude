"use client";

/**
 * DESIGN PREVIEW — sample operator dashboard (doc 06 §5), rendered in the
 * operator's REAL brand (Core Blue / Core Orange / Alachua on a Spendex-airy
 * light-grey canvas). This is a VISUAL TARGET for reaction — NOT the live M19
 * module (doc 07 §1.10 builds that later; it will match this).
 *
 * Everything is token-driven — no hardcoded brand values — so this preview
 * re-skins per tenant exactly like the real app. Gradient washes appear only on
 * "moment" surfaces (the gauge = Core Blue 90°; the opportunity strip = Core
 * Orange 45°), per the brand guide. Motion is confined to the Visibility-Score
 * resolve and respects prefers-reduced-motion via the frozen gate.
 */

import * as React from "react";
import {
  ActivityIcon,
  ArrowUpRightIcon,
  FileTextIcon,
  RotateCwIcon,
  SparklesIcon,
  TargetIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EngineCitations, VisibilityTrend } from "@/components/charts";
import {
  AlertsList,
  ArrowButton,
  Delta,
  PillBars,
  PipelineMini,
  StatCard,
  VisibilityGauge,
} from "@/components/dashboard-preview";

const TREND = [
  { date: "Apr 14", score: 52 },
  { date: "Apr 21", score: 54 },
  { date: "Apr 28", score: 53 },
  { date: "May 5", score: 58 },
  { date: "May 12", score: 60 },
  { date: "May 19", score: 59 },
  { date: "May 26", score: 63 },
  { date: "Jun 2", score: 62 },
  { date: "Jun 9", score: 65 },
  { date: "Jun 16", score: 66 },
  { date: "Jun 23", score: 67 },
  { date: "Jun 30", score: 68 },
];

const ENGINES = [
  { engine: "ChatGPT", status: "cited" as const, detail: "4 citations" },
  { engine: "Claude", status: "cited" as const, detail: "3 citations" },
  { engine: "Perplexity", status: "cited" as const, detail: "#1 source" },
  { engine: "Google AIO", status: "cited" as const, detail: "2 citations" },
  { engine: "Gemini", status: "lost" as const, detail: "dropped Jun 30" },
  { engine: "Copilot", status: "missing" as const },
];

const SHARE_OF_VOICE = [
  { name: "Harborline Realty", share: 34, isClient: true },
  { name: "Compass SD", share: 27 },
  { name: "Shoreline Group", share: 19 },
  { name: "Pacific Key Homes", share: 12 },
  { name: "Casa Vista", share: 8 },
];

const ALERTS = [
  {
    icon: TriangleAlertIcon,
    title: "Gemini dropped your citation",
    meta: "Visibility · Jun 30 · needs a freshness pass",
    tone: "negative" as const,
  },
  {
    icon: TrendingUpIcon,
    title: "Perplexity now ranks you #1 source",
    meta: "Visibility · up from #3 last week",
    tone: "positive" as const,
  },
  {
    icon: SparklesIcon,
    title: "3 FAQ answers ready to review",
    meta: "Content · humanized · awaiting approval",
    tone: "accent" as const,
  },
  {
    icon: TargetIcon,
    title: "Local pack gap: 'realtor near La Jolla'",
    meta: "Local SEO · competitor cited, you're not",
    tone: "warm" as const,
  },
];

const PIPELINE = [
  { label: "Generate", count: 8, state: "done" as const },
  { label: "Humanize", count: 5, state: "done" as const },
  { label: "Review", count: 3, state: "current" as const },
  { label: "Publish", count: 2, state: "pending" as const },
];

/** A moment-surface gradient wash (blue 90° / orange 45°), per the brand guide. */
function washStyle(kind: "blue90" | "orange45"): React.CSSProperties {
  return kind === "blue90"
    ? {
        background:
          "linear-gradient(90deg, color-mix(in oklab, var(--accent) 13%, transparent), transparent 58%), var(--surface-raised)",
      }
    : {
        background:
          "linear-gradient(45deg, color-mix(in oklab, var(--accent-secondary) 15%, transparent), transparent 68%), var(--surface-raised)",
      };
}

export function DashboardPreview() {
  const [replay, setReplay] = React.useState(0);

  return (
    <div className="min-h-full bg-surface">
      {/* Unmistakable preview banner */}
      <div
        className="border-b border-border"
        style={{ background: "color-mix(in oklab, var(--accent) 8%, transparent)" }}
      >
        <p className="mx-auto flex w-full max-w-6xl items-center gap-2 px-6 py-2 text-xs text-ink">
          <SparklesIcon aria-hidden className="size-3.5 text-accent" />
          <span className="font-medium">Design preview</span>
          <span className="text-muted">
            — sample data, not the live dashboard. A visual target the M19 client
            dashboard will match.
          </span>
        </p>
      </div>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
        {/* Header */}
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="flex flex-col gap-2">
            <p className="font-mono text-[11px] tracking-[0.2em] text-muted uppercase">
              Client dashboard · preview
            </p>
            <h1 className="font-display text-3xl text-ink">Harborline Realty</h1>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">Real estate</Badge>
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                San Diego, CA
              </Badge>
              <span className="font-mono text-xs text-muted">Updated 2 min ago</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setReplay((n) => n + 1)}
            >
              <RotateCwIcon aria-hidden />
              Replay resolve
            </Button>
            <Button size="sm">
              <FileTextIcon aria-hidden />
              Weekly report
            </Button>
          </div>
        </header>

        {/* Hero: gauge (resolve moment) + trend */}
        <section className="grid gap-6 lg:grid-cols-2">
          <Card className="overflow-hidden py-0" style={washStyle("blue90")}>
            <div className="flex flex-col gap-6 p-6">
              <VisibilityGauge
                score={68}
                caption="+6 since last run · resolving out of noise"
                replayKey={replay}
              />
              <div className="border-t border-border pt-5">
                <p className="mb-3 font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
                  Cited by engine
                </p>
                <EngineCitations data={ENGINES} />
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <CardTitle>Visibility over time</CardTitle>
                  <CardDescription>Weekly tracker runs, last 12 weeks</CardDescription>
                </div>
                <ArrowButton label="Open visibility history" />
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <VisibilityTrend data={TREND} height={220} />
              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
                <div className="flex flex-col gap-1">
                  <span
                    className="font-display text-2xl leading-none text-ink"
                    style={{ fontWeight: 300 }}
                  >
                    +16
                  </span>
                  <span className="font-mono text-[11px] tracking-wide text-muted uppercase">
                    since April
                  </span>
                </div>
                <Delta value={12} unit="%" context="vs prior 12 weeks" />
              </div>
            </CardContent>
          </Card>
        </section>

        {/* Stat tiles */}
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="AI citations"
            value="3,412"
            delta={{ value: 12, unit: "%", context: "vs last run" }}
          />
          <StatCard
            label="Share of voice"
            value="34"
            unit="%"
            delta={{ value: 5, unit: "pts", context: "vs last run" }}
          />
          <StatCard
            label="Avg. AI position"
            value="#2"
            delta={{ value: 1, unit: "", context: "position gained" }}
          />
          <StatCard
            label="Content ROI"
            value="4.8"
            unit="×"
            delta={{ value: -0.3, unit: "×", context: "vs last month" }}
          />
        </section>

        {/* Opportunity strip — the Core Orange "energy" moment (45° wash) */}
        <section
          className="flex flex-wrap items-center gap-4 rounded-xl border border-border p-5"
          style={washStyle("orange45")}
        >
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-full"
            style={{ background: "color-mix(in oklab, var(--accent-secondary) 18%, transparent)" }}
          >
            <ActivityIcon className="size-5 text-accent-secondary" strokeWidth={2} />
          </span>
          <div className="mr-auto flex min-w-0 flex-col gap-0.5">
            <p className="text-sm font-semibold text-ink">
              3 competitor citation gaps to capture this week
            </p>
            <p className="text-sm text-muted">
              Compass SD is cited where you aren&apos;t — a targeted FAQ + schema pass closes it.
            </p>
          </div>
          <Button variant="outline" size="sm">
            Review opportunities
            <ArrowUpRightIcon aria-hidden />
          </Button>
        </section>

        {/* Share of voice + alerts */}
        <section className="grid gap-6 lg:grid-cols-[1.25fr_1fr]">
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <CardTitle>Share of voice</CardTitle>
                  <CardDescription>
                    AI citations vs named competitors, June
                  </CardDescription>
                </div>
                <ArrowButton label="Open share of voice" />
              </div>
            </CardHeader>
            <CardContent>
              <PillBars data={SHARE_OF_VOICE} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Alerts &amp; tasks</CardTitle>
              <CardDescription>What needs a human this week</CardDescription>
            </CardHeader>
            <CardContent>
              <AlertsList items={ALERTS} />
            </CardContent>
          </Card>
        </section>

        {/* Content pipeline */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <CardTitle>Content pipeline</CardTitle>
                <CardDescription>
                  Draft → humanize → review → publish · nothing advances past a failed gate
                </CardDescription>
              </div>
              <Badge variant="secondary" className="font-mono text-[10px] uppercase">
                18 in flight
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-2">
            <PipelineMini stages={PIPELINE} className="mx-auto max-w-2xl" />
          </CardContent>
        </Card>

        <footer className="border-t border-border pt-6">
          <p className="max-w-3xl text-xs leading-5 text-muted">
            Preview only. Sample data. Rendered entirely from design tokens in the
            operator brand — swap the tenant theme and this whole page re-skins with
            zero code changes. The live M19 client dashboard (built later) matches
            this visual target.
          </p>
        </footer>
      </main>
    </div>
  );
}
