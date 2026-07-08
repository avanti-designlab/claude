"use client";

/**
 * DESIGN PREVIEW — sample operator dashboard (doc 06 §5), rendered in the
 * operator's REAL brand (Core Blue / Core Orange / Alachua gold / Dark-Blue
 * navy on a light-grey canvas). A VISUAL TARGET for reaction — NOT the live
 * M19 module (doc 07 §1.10 builds that later; it will match this).
 *
 * Iteration 2 (operator direction, 2026-07-08): a full-width Core Blue HERO
 * anchors the page (blue gradient at 90° per the brand guide) with circular
 * quick actions and the score resolving inside it; the numbers and section
 * headings go BIG + BOLD (`--text-hero` additive step, display face at 700);
 * and the color arrives as RHYTHM, not wallpaper — exactly four colored zones
 * (blue hero, one FILLED Core Blue stat tile with a light sparkline, the Core
 * Orange energy panel at 45° with a white circular ↗, and a Dark-Blue depth
 * tile), plus soft gold/blue washes. Supporting cards stay light so the color
 * has impact.
 *
 * Interactive: count-ups on the big numbers, hover lifts on cards/tiles,
 * hover-highlighted share-of-voice rows, and fill-invert circular arrows —
 * all 150–250ms, all transforms motion-safe, and every count-up renders its
 * final state instantly under the frozen reduced-motion gate. Dense data
 * (engine grid, alerts) stays quiet.
 *
 * Everything is token-driven — no hardcoded brand values — so this preview
 * re-skins per tenant. Text on every filled surface uses the DERIVED on-color
 * foregrounds (--accent-foreground etc.) or the opposing surface tokens —
 * never a raw white assumption.
 */

import * as React from "react";
import {
  ActivityIcon,
  FileTextIcon,
  type LucideIcon,
  PlusIcon,
  RadarIcon,
  RotateCwIcon,
  SparklesIcon,
  TargetIcon,
  TrendingUpIcon,
  TriangleAlertIcon,
  ZapIcon,
} from "lucide-react";
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
  CountUpValue,
  Delta,
  PillBars,
  PipelineMini,
  StatCard,
  VisibilityGauge,
  WashPill,
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

const CITATION_SPARK = [38, 42, 40, 47, 52, 50, 58, 64];

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

/**
 * Moment-surface backgrounds. Each is a gradient over TOKENS (blue at 90°,
 * orange at 45° per the brand guide; the navy is the ink token nudged toward
 * Core Blue) — never a literal color.
 */
const HERO_BG: React.CSSProperties = {
  background:
    "radial-gradient(130% 150% at 84% -20%, color-mix(in oklab, var(--surface-raised) 16%, transparent), transparent 55%), linear-gradient(90deg, var(--accent), color-mix(in oklab, var(--accent) 54%, var(--ink)))",
};
const ORANGE_BG: React.CSSProperties = {
  background:
    "radial-gradient(120% 150% at 0% 0%, color-mix(in oklab, var(--surface-raised) 20%, transparent), transparent 52%), linear-gradient(45deg, var(--accent-secondary), color-mix(in oklab, var(--accent-secondary) 66%, var(--accent-warm)))",
};
const DARK_BG: React.CSSProperties = {
  background:
    "radial-gradient(130% 140% at 100% 0%, color-mix(in oklab, var(--accent) 42%, transparent), transparent 60%), linear-gradient(140deg, var(--ink), color-mix(in oklab, var(--ink) 78%, var(--accent)))",
};

/** A subtle Core Blue 90° wash to tie a light analytics card back to the hero. */
const BLUE_WASH: React.CSSProperties = {
  background:
    "linear-gradient(90deg, color-mix(in oklab, var(--accent) 9%, transparent), transparent 60%), var(--surface-raised)",
};

/**
 * A quick-action: a frosted circular icon button in the hero (Ref A). Colors
 * ride the DERIVED --accent-foreground so they re-derive on any tenant accent;
 * hover is a fill-invert to a solid on-color circle with the accent glyph.
 */
function HeroAction({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent-foreground/70"
    >
      <span
        aria-hidden
        className={
          "flex size-12 items-center justify-center rounded-full border border-accent-foreground/25 bg-accent-foreground/14 text-accent-foreground " +
          "transition-[transform,box-shadow,background-color,color] duration-200 " +
          "group-hover:bg-accent-foreground group-hover:text-accent group-hover:shadow-lg motion-safe:group-hover:-translate-y-0.5"
        }
      >
        <Icon className="size-5" strokeWidth={2} />
      </span>
      <span className="text-xs font-medium text-accent-foreground/85">{label}</span>
    </button>
  );
}

/** Bold section heading — display face, heavy, "Webflow-AEO" scale. */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <CardTitle className="font-display text-2xl leading-tight font-bold">
      {children}
    </CardTitle>
  );
}

export function DashboardPreview() {
  const [replay, setReplay] = React.useState(0);
  const bumpReplay = () => setReplay((n) => n + 1);

  return (
    <div className="min-h-full bg-surface pb-14">
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

      {/* ====================================================================
          HERO — full-width Core Blue band (90° gradient), the page anchor.
          Big bold headline + quick actions, the Visibility Score resolving
          large & bold on the right. All text via --accent-foreground.
          ==================================================================== */}
      <section className="w-full text-accent-foreground" style={HERO_BG}>
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 pt-10 pb-24 lg:grid-cols-[1.35fr_auto] lg:items-center">
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] tracking-[0.2em] text-accent-foreground/70 uppercase">
                Client dashboard · preview
              </span>
            </div>
            <div className="flex flex-col gap-4">
              <h1 className="font-display text-display leading-[1.02] font-bold sm:text-hero">
                Harborline Realty
              </h1>
              <p className="max-w-lg text-lg text-accent-foreground/85">
                You&apos;re winning AI search in San Diego. Here&apos;s where to
                press this week.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-accent-foreground/25 bg-accent-foreground/12 px-2.5 py-0.5 font-mono text-[10px] tracking-wide uppercase">
                  Real estate
                </span>
                <span className="inline-flex items-center rounded-full border border-accent-foreground/25 bg-accent-foreground/12 px-2.5 py-0.5 font-mono text-[10px] tracking-wide uppercase">
                  San Diego, CA
                </span>
                <span className="font-mono text-xs text-accent-foreground/70">
                  Updated 2 min ago
                </span>
              </div>
            </div>

            {/* Quick-action circular icon buttons (Ref A) */}
            <div className="flex flex-wrap items-start gap-5 pt-1">
              <HeroAction icon={RotateCwIcon} label="Replay resolve" onClick={bumpReplay} />
              <HeroAction icon={FileTextIcon} label="Weekly report" />
              <HeroAction icon={RadarIcon} label="Run tracker" />
              <HeroAction icon={PlusIcon} label="New content" />
            </div>
          </div>

          {/* Visibility Score — the signature resolve moment, on the hero */}
          <div className="flex justify-center lg:justify-end">
            <VisibilityGauge
              score={68}
              tone="onAccent"
              size="lg"
              caption="+6 since last run · resolving out of the noise"
              replayKey={replay}
            />
          </div>
        </div>
      </section>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-9 px-6">
        {/* KPI strip — floats up to overlap the hero (Ref A). One FILLED Core
            Blue tile with a light sparkline (Ref B's filled stat tile, in our
            blue) + a soft gold wash + two light supporting tiles. Numbers
            count up, big & bold. */}
        <section className="relative z-10 -mt-16 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            tone="blue"
            label="AI citations"
            value="3,412"
            sparkline={CITATION_SPARK}
            delta={{ value: 12, unit: "%", context: "vs last run" }}
          />
          <StatCard
            tone="gold"
            label="Share of voice"
            value="34"
            unit="%"
            delta={{ value: 5, unit: "pts", context: "vs last run" }}
          />
          <StatCard
            tone="plain"
            label="Avg. AI position"
            value="#2"
            delta={{ value: 1, unit: "", context: "position gained" }}
          />
          <StatCard
            tone="plain"
            label="Content ROI"
            value="4.8"
            unit="×"
            delta={{ value: -0.3, unit: "×", context: "vs last month" }}
          />
        </section>

        {/* Highlight row — the "not all white" statement: a Core Orange energy
            panel (45°) with a white circular ↗ + a Dark-Blue depth tile. */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Core Orange energy panel — derived on-orange foreground text */}
          <div
            className="group relative flex flex-col gap-5 overflow-hidden rounded-xl border border-transparent p-6 text-accent-secondary-foreground shadow-sm transition-[transform,box-shadow] duration-200 hover:shadow-xl motion-safe:hover:-translate-y-1 lg:col-span-2"
            style={ORANGE_BG}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="flex size-10 shrink-0 items-center justify-center rounded-full"
                  style={{ background: "color-mix(in oklab, var(--ink) 14%, transparent)" }}
                >
                  <ZapIcon className="size-5" strokeWidth={2.25} />
                </span>
                <p className="font-mono text-[11px] tracking-[0.18em] uppercase opacity-80">
                  Opportunities to capture · this week
                </p>
              </div>
              {/* The white circular arrow — THE affordance (Ref B), inverts on hover */}
              <ArrowButton label="Review opportunities" tone="surface" size="lg" />
            </div>

            <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
              <CountUpValue
                value="3"
                className="font-display text-hero leading-none font-bold tabular-nums"
              />
              <p className="max-w-md pb-1 text-lg font-medium">
                competitor citation gaps you can close — Compass SD is cited where
                you aren&apos;t.
              </p>
            </div>

            <p className="max-w-xl text-sm opacity-85">
              A targeted FAQ pass plus schema on three La Jolla queries wins back
              the citations. Est. +4 to visibility.
            </p>
          </div>

          {/* Dark-Blue depth tile — light number over the ink fill */}
          <div
            className="group relative flex flex-col justify-between gap-6 overflow-hidden rounded-xl border border-transparent p-6 text-surface-raised shadow-sm transition-[transform,box-shadow] duration-200 hover:shadow-xl motion-safe:hover:-translate-y-1"
            style={DARK_BG}
          >
            <div className="flex items-center gap-2">
              <TrendingUpIcon className="size-4 text-surface-raised/80" strokeWidth={2} />
              <p className="font-mono text-[11px] tracking-[0.18em] text-surface-raised/70 uppercase">
                Momentum · 12 weeks
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <CountUpValue
                value="+16"
                className="font-display text-score leading-none font-bold tabular-nums"
              />
              <p className="text-sm text-surface-raised/80">
                visibility points since April — resolving steadily out of the noise.
              </p>
              <Delta
                value={12}
                unit="%"
                context="vs prior 12 weeks"
                onColor
                contextClassName="text-surface-raised/70"
              />
            </div>
          </div>
        </section>

        {/* Analytics — visibility trend + per-engine citations (light cards) */}
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card
            style={BLUE_WASH}
            className="transition-[transform,box-shadow] duration-200 hover:shadow-lg motion-safe:hover:-translate-y-1"
          >
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <SectionTitle>Visibility over time</SectionTitle>
                  <CardDescription>Weekly tracker runs, last 12 weeks</CardDescription>
                </div>
                <ArrowButton label="Open visibility history" />
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-5">
              <VisibilityTrend data={TREND} height={220} />
              <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border pt-4">
                <div className="flex flex-col gap-1">
                  <CountUpValue
                    value="+16"
                    className="font-display text-3xl leading-none font-bold tabular-nums text-ink"
                  />
                  <span className="font-mono text-[11px] tracking-wide text-muted uppercase">
                    since April
                  </span>
                </div>
                <Delta value={12} unit="%" context="vs prior 12 weeks" />
              </div>
            </CardContent>
          </Card>

          <Card className="transition-[transform,box-shadow] duration-200 hover:shadow-lg motion-safe:hover:-translate-y-1">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <SectionTitle>Cited by engine</SectionTitle>
                  <CardDescription>Where the AI engines surface you now</CardDescription>
                </div>
                <WashPill tone="gold">4 of 6 cited</WashPill>
              </div>
            </CardHeader>
            <CardContent>
              <EngineCitations data={ENGINES} />
            </CardContent>
          </Card>
        </section>

        {/* Share of voice + alerts */}
        {/* minmax(0,…) so the alerts rows' truncating text can never drive the
            track wider than the container (fr min is `auto` otherwise). */}
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <Card className="transition-[transform,box-shadow] duration-200 hover:shadow-lg motion-safe:hover:-translate-y-1">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <SectionTitle>Share of voice</SectionTitle>
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

          <Card className="transition-[transform,box-shadow] duration-200 hover:shadow-lg motion-safe:hover:-translate-y-1">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <SectionTitle>Alerts &amp; tasks</SectionTitle>
                  <CardDescription>What needs a human this week</CardDescription>
                </div>
                <WashPill tone="orange">1 priority</WashPill>
              </div>
            </CardHeader>
            <CardContent>
              <AlertsList items={ALERTS} />
            </CardContent>
          </Card>
        </section>

        {/* Content pipeline */}
        <Card className="transition-[transform,box-shadow] duration-200 hover:shadow-lg motion-safe:hover:-translate-y-1">
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="flex flex-col gap-1">
                <SectionTitle>Content pipeline</SectionTitle>
                <CardDescription>
                  Draft → humanize → review → publish · nothing advances past a failed gate
                </CardDescription>
              </div>
              <WashPill tone="blue">
                <ActivityIcon aria-hidden className="size-3" />
                18 in flight
              </WashPill>
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
