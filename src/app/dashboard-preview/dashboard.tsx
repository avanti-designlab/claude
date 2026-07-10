"use client";

/**
 * DESIGN PREVIEW — sample operator dashboard (doc 06 §5), working brand v1
 * (pass 3 consolidated app-wide, 2026-07-08). A VISUAL TARGET for reaction —
 * NOT the live M19 module (doc 07 §1.10 builds that later; it will match).
 *
 * The "illuminated" BLUE-DEPTH treatment, now MODE-AWARE app-wide:
 *  - The hero is a FLOATING ROUNDED BUBBLE (generous radius, margin from the
 *    viewport) with the backlit-glass edge: thin light-cyan gradient border,
 *    soft blue outer bloom, radial glow inside the fill (GlowCard).
 *  - Light/dark are the operator theme's real modes — the standard mechanism
 *    (OS preference + data-theme override) picks the palette; the page-level
 *    toggle (Light / Dark glow) drives that same mechanism. Mode-dependent
 *    foregrounds ride the `dark:` variant — pure token derivations both ways.
 *  - "Needs fixing" urgency wears the semantic NEGATIVE red (wash + red
 *    accents) — never orange, never the brand accent.
 *  - Face is Geist (operator theme) — weight + tight tracking carry the
 *    hierarchy, Apple/Webflow style.
 *
 * ENTRANCE CHOREOGRAPHY (operator direction): one orchestrated entrance per
 * page load — cards stagger in (rise + fade via <Entrance>), the hero's glow
 * blooms after the card lands, and every count-up/gauge resolve starts only
 * after its own tile has entered (counterDelayMs). Reduced motion renders
 * everything in its final state instantly (both gates). Transforms/opacity
 * only — zero layout shift. Everything is token-driven — no hardcoded brand
 * values — so this preview re-skins per tenant.
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
  WrenchIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EngineCitations, VisibilityTrend } from "@/components/charts";
import { counterDelayMs, Entrance } from "@/components/moments";
import {
  AlertsList,
  ArrowButton,
  CountUpValue,
  Delta,
  GlowCard,
  ModeToggle,
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
    tone: "accent" as const,
  },
];

const PIPELINE = [
  { label: "Generate", count: 8, state: "done" as const },
  { label: "Humanize", count: 5, state: "done" as const },
  { label: "Review", count: 3, state: "current" as const },
  { label: "Publish", count: 2, state: "pending" as const },
];

/** A subtle primary-blue 90° wash to tie a light analytics card to the hero. */
const BLUE_WASH: React.CSSProperties = {
  background:
    "linear-gradient(90deg, color-mix(in oklab, var(--accent) 9%, transparent), transparent 60%), var(--surface-raised)",
};

/**
 * Hero foregrounds, MODE-AWARE via the `dark:` variant. In light mode the
 * hero is a vivid-blue fill, so text rides the DERIVED --accent-foreground;
 * in dark mode it is a navy-to-black fill, so text rides the (light)
 * ink/muted tokens directly. Pure token choices — never a raw white
 * assumption.
 */
const HERO = {
  base: "text-accent-foreground dark:text-ink",
  soft: "text-accent-foreground/85 dark:text-ink/85",
  dim: "text-accent-foreground/70 dark:text-muted",
  badge:
    "border-accent-foreground/25 bg-accent-foreground/12 dark:border-ink/20 dark:bg-ink/8",
  actionCircle:
    "border-accent-foreground/25 bg-accent-foreground/14 text-accent-foreground group-hover:bg-accent-foreground group-hover:text-accent " +
    "dark:border-ink/20 dark:bg-ink/10 dark:text-ink dark:group-hover:bg-ink dark:group-hover:text-surface",
  actionLabel: "text-accent-foreground/85 dark:text-ink/80",
  actionRing: "focus-visible:ring-accent-foreground/70 dark:focus-visible:ring-ring/70",
};

/** Momentum depth-tile foregrounds (navy fill on light; near-black on dark). */
const DEEP = {
  base: "text-surface-raised dark:text-ink",
  soft: "text-surface-raised/80 dark:text-ink/80",
  dim: "text-surface-raised/70 dark:text-muted",
};

/**
 * A quick-action: a frosted circular icon button inside the hero card. Colors
 * ride the mode-aware hero foreground classes; hover is a fill-invert.
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
      className={
        "group flex flex-col items-center gap-2 rounded-lg outline-none focus-visible:ring-2 " +
        HERO.actionRing
      }
    >
      <span
        aria-hidden
        className={
          "flex size-12 items-center justify-center rounded-full border " +
          "transition-[transform,box-shadow,background-color,color] duration-200 " +
          "group-hover:shadow-lg motion-safe:group-hover:-translate-y-0.5 " +
          HERO.actionCircle
        }
      >
        <Icon className="size-5" strokeWidth={2} />
      </span>
      <span className={"text-xs font-medium " + HERO.actionLabel}>{label}</span>
    </button>
  );
}

/** Bold section heading — display face, heavy, tight (the Geist look). */
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <CardTitle className="font-display text-2xl leading-tight font-bold tracking-tight">
      {children}
    </CardTitle>
  );
}

export function DashboardPreview() {
  const [replay, setReplay] = React.useState(0);
  const bumpReplay = () => setReplay((n) => n + 1);

  return (
    <div className="min-h-full bg-surface pb-14">
      {/* Unmistakable preview banner + the standard mode toggle (instant —
          page chrome stays out of the choreography) */}
      <div
        className="border-b border-border"
        style={{ background: "color-mix(in oklab, var(--accent) 8%, transparent)" }}
      >
        <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-4 py-2 text-xs text-ink sm:px-6">
          <SparklesIcon aria-hidden className="size-3.5 shrink-0 text-accent" />
          <span className="font-medium">Design preview</span>
          <span className="hidden text-muted sm:inline">
            — sample data, not the live dashboard. Light and dark are the
            operator brand&apos;s two modes.
          </span>
          <span className="ml-auto">
            {/* The preview OWNS the "Dark glow" label — it names this page's
                glow showpiece. Product surfaces use the plain default. */}
            <ModeToggle labels={{ light: "Light", dark: "Dark glow" }} />
          </span>
        </div>
      </div>

      {/* ====================================================================
          HERO — the floating rounded bubble, illuminated: thin cyan gradient
          edge + soft bloom + inner radial glow (GlowCard). Entrance step 0;
          the glow blooms in after the card lands; the score resolve starts
          after the hero has entered.
          ==================================================================== */}
      <Entrance step={0} className="mx-auto w-full max-w-6xl px-4 pt-6 sm:px-6">
        <GlowCard surface="hero" scale="hero" bloom>
          <section
            className={
              "grid gap-10 p-7 sm:p-10 lg:grid-cols-[1.35fr_auto] lg:items-center lg:p-12 " +
              HERO.base
            }
          >
            <div className="flex flex-col gap-6">
              <span
                className={
                  "font-mono text-[11px] tracking-[0.2em] uppercase " + HERO.dim
                }
              >
                Client dashboard · preview
              </span>
              <div className="flex flex-col gap-4">
                <h1 className="font-display text-display leading-[1.02] font-bold tracking-[-0.02em] sm:text-hero">
                  Harborline Realty
                </h1>
                <p className={"max-w-lg text-lg " + HERO.soft}>
                  You&apos;re winning AI search in San Diego. Here&apos;s where to
                  press this week.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={
                      "inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[10px] tracking-wide uppercase " +
                      HERO.badge
                    }
                  >
                    Real estate
                  </span>
                  <span
                    className={
                      "inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[10px] tracking-wide uppercase " +
                      HERO.badge
                    }
                  >
                    San Diego, CA
                  </span>
                  <span className={"font-mono text-xs " + HERO.dim}>
                    Updated 2 min ago
                  </span>
                </div>
              </div>

              {/* Quick-action circular icon buttons */}
              <div className="flex flex-wrap items-start gap-5 pt-1">
                <HeroAction
                  icon={RotateCwIcon}
                  label="Replay resolve"
                  onClick={bumpReplay}
                />
                <HeroAction icon={FileTextIcon} label="Weekly report" />
                <HeroAction icon={RadarIcon} label="Run tracker" />
                <HeroAction icon={PlusIcon} label="New content" />
              </div>
            </div>

            {/* Visibility Score — the signature resolve moment, sequenced
                after the hero's entrance */}
            <div className="flex justify-center lg:justify-end">
              <VisibilityGauge
                score={68}
                tone="hero"
                size="lg"
                caption="+6 since last run · resolving out of the noise"
                replayKey={replay}
                delay={counterDelayMs(0)}
              />
            </div>
          </section>
        </GlowCard>
      </Entrance>

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-9 px-4 pt-9 sm:px-6">
        {/* KPI strip — steps 1–4: the showcase glow bubble + a soft sky wash
            + two quiet tiles. Numbers count up AFTER their tile lands. */}
        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Entrance step={1}>
            <StatCard
              tone="glow"
              bloom
              label="AI citations"
              value="3,412"
              sparkline={CITATION_SPARK}
              delta={{ value: 12, unit: "%", context: "vs last run" }}
              countDelay={counterDelayMs(1)}
            />
          </Entrance>
          <Entrance step={2}>
            <StatCard
              tone="sky"
              label="Share of voice"
              value="34"
              unit="%"
              delta={{ value: 5, unit: "pts", context: "vs last run" }}
              countDelay={counterDelayMs(2)}
            />
          </Entrance>
          <Entrance step={3}>
            <StatCard
              tone="plain"
              label="Avg. AI position"
              value="#2"
              delta={{ value: 1, unit: "", context: "position gained" }}
              countDelay={counterDelayMs(3)}
            />
          </Entrance>
          <Entrance step={4}>
            <StatCard
              tone="plain"
              label="Content ROI"
              value="4.8"
              unit="×"
              delta={{ value: -0.3, unit: "×", context: "vs last month" }}
              countDelay={counterDelayMs(4)}
            />
          </Entrance>
        </section>

        {/* Highlight row — urgency + momentum. The "needs fixing" panel wears
            the semantic NEGATIVE red (wash + red accents — operator: "red is
            smart for action items"); the momentum tile is the illuminated
            depth tile. */}
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Needs-fixing panel — red urgency, never orange */}
          <Entrance step={5} className="lg:col-span-2">
            <GlowCard
              surface="alert"
              className="group flex h-full flex-col gap-5 p-6 text-ink transition-transform duration-200 motion-safe:hover:-translate-y-1"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden
                    className="flex size-10 shrink-0 items-center justify-center rounded-full"
                    style={{
                      background: "color-mix(in oklab, var(--negative) 14%, transparent)",
                    }}
                  >
                    <WrenchIcon className="size-5 text-negative" strokeWidth={2.25} />
                  </span>
                  <p className="font-mono text-[11px] tracking-[0.18em] text-negative uppercase">
                    Needs fixing · this week
                  </p>
                </div>
                {/* The urgency arrow — semantic red, inverts on hover */}
                <ArrowButton label="Review fixes" tone="negative" size="lg" />
              </div>

              <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
                <CountUpValue
                  value="3"
                  delay={counterDelayMs(5)}
                  className="font-display text-hero leading-none font-bold tracking-tight tabular-nums"
                />
                <p className="max-w-md pb-1 text-lg font-medium">
                  competitor citation gaps to close — Compass SD is cited where you
                  aren&apos;t.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <WashPill tone="negative">1 high priority</WashPill>
                <p className="max-w-xl text-sm text-muted">
                  A targeted FAQ pass plus schema on three La Jolla queries wins back
                  the citations. Est. +4 to visibility.
                </p>
              </div>
            </GlowCard>
          </Entrance>

          {/* Momentum depth tile — illuminated navy, blue glow rising */}
          <Entrance step={6}>
            <GlowCard
              surface="deep"
              className={
                "group flex h-full flex-col justify-between gap-6 p-6 transition-transform duration-200 motion-safe:hover:-translate-y-1 " +
                DEEP.base
              }
            >
              <div className="flex items-center gap-2">
                <TrendingUpIcon className={"size-4 " + DEEP.soft} strokeWidth={2} />
                <p
                  className={
                    "font-mono text-[11px] tracking-[0.18em] uppercase " + DEEP.dim
                  }
                >
                  Momentum · 12 weeks
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <CountUpValue
                  value="+16"
                  delay={counterDelayMs(6)}
                  className="font-display text-score leading-none font-bold tracking-tight tabular-nums"
                />
                <p className={"text-sm " + DEEP.soft}>
                  visibility points since April — resolving steadily out of the noise.
                </p>
                <Delta
                  value={12}
                  unit="%"
                  context="vs prior 12 weeks"
                  on="deep"
                  contextClassName={DEEP.dim}
                />
              </div>
            </GlowCard>
          </Entrance>
        </section>

        {/* Analytics — visibility trend + per-engine citations (quiet cards) */}
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Entrance step={7}>
            <Card
              style={BLUE_WASH}
              className="h-full transition-[transform,box-shadow] duration-200 hover:shadow-lg motion-safe:hover:-translate-y-1"
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
                      delay={counterDelayMs(7)}
                      className="font-display text-3xl leading-none font-bold tracking-tight tabular-nums text-ink"
                    />
                    <span className="font-mono text-[11px] tracking-wide text-muted uppercase">
                      since April
                    </span>
                  </div>
                  <Delta value={12} unit="%" context="vs prior 12 weeks" />
                </div>
              </CardContent>
            </Card>
          </Entrance>

          <Entrance step={8}>
            <Card className="h-full transition-[transform,box-shadow] duration-200 hover:shadow-lg motion-safe:hover:-translate-y-1">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <SectionTitle>Cited by engine</SectionTitle>
                    <CardDescription>Where the AI engines surface you now</CardDescription>
                  </div>
                  <WashPill tone="blue">4 of 6 cited</WashPill>
                </div>
              </CardHeader>
              <CardContent>
                <EngineCitations data={ENGINES} />
              </CardContent>
            </Card>
          </Entrance>
        </section>

        {/* Share of voice + alerts */}
        {/* minmax(0,…) so the alerts rows' truncating text can never drive the
            track wider than the container (fr min is `auto` otherwise). */}
        <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          <Entrance step={9}>
            <Card className="h-full transition-[transform,box-shadow] duration-200 hover:shadow-lg motion-safe:hover:-translate-y-1">
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
          </Entrance>

          <Entrance step={10}>
            <Card className="h-full transition-[transform,box-shadow] duration-200 hover:shadow-lg motion-safe:hover:-translate-y-1">
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <SectionTitle>Alerts &amp; tasks</SectionTitle>
                    <CardDescription>What needs a human this week</CardDescription>
                  </div>
                  <WashPill tone="negative">1 priority</WashPill>
                </div>
              </CardHeader>
              <CardContent>
                <AlertsList items={ALERTS} />
              </CardContent>
            </Card>
          </Entrance>
        </section>

        {/* Content pipeline */}
        <Entrance step={11}>
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
        </Entrance>

        <footer className="border-t border-border pt-6">
          <p className="max-w-3xl text-xs leading-5 text-muted">
            Preview only. Sample data. Working brand v1 — the operator&apos;s
            dual-palette blue-depth theme (light / dark glow) rendered entirely
            from design tokens through the frozen theming engine; swap the
            tenant theme and this whole page re-skins with zero code changes.
            The live M19 client dashboard (built later) matches this target.
          </p>
        </footer>
      </main>
    </div>
  );
}
