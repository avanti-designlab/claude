import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  BarChart3Icon,
  BotIcon,
  CompassIcon,
  FileTextIcon,
  GaugeIcon,
  LayoutDashboardIcon,
  MapPinnedIcon,
  PenLineIcon,
  ShieldCheckIcon,
  SparklesIcon,
  SwatchBookIcon,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

export const metadata: Metadata = {
  title: "AEO/GEO + Brand Production OS",
  description:
    "AI-native agency operating system — AEO/GEO intelligence with brand-consistent production. One page to watch what's built and what's coming.",
};

interface LiveEntry {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

const LIVE: LiveEntry[] = [
  {
    href: "/onboarding",
    title: "Client onboarding",
    description:
      "Pick an industry, add locations and properties, and reveal a real playbook-driven AEO/GEO/local plan.",
    icon: SparklesIcon,
  },
  {
    href: "/design-system",
    title: "Design system",
    description:
      "The frozen F2 “Signal” system: tokens, white-label theming, components, charts, and the five animated moments.",
    icon: SwatchBookIcon,
  },
];

interface ComingEntry {
  code: string;
  title: string;
  description: string;
  icon: LucideIcon;
}

const COMING: ComingEntry[] = [
  {
    code: "M2",
    title: "Audit engine",
    description: "Scores a site against the playbook rubric and returns prioritized fixes.",
    icon: GaugeIcon,
  },
  {
    code: "M3",
    title: "Visibility tracker",
    description: "Tracks AI-engine citations across ChatGPT, Perplexity, Gemini, and more.",
    icon: BarChart3Icon,
  },
  {
    code: "M4",
    title: "Competitor analysis",
    description: "Reverse-engineers why competitors get cited — and where the gaps are.",
    icon: CompassIcon,
  },
  {
    code: "M8",
    title: "Content production",
    description: "Brand-consistent drafts through the humanize → review → publish pipeline.",
    icon: PenLineIcon,
  },
  {
    code: "M14",
    title: "Local SEO",
    description: "GBP, NAP consistency, and local rankings tuned to playbook intensity.",
    icon: MapPinnedIcon,
  },
  {
    code: "M13",
    title: "Auto-fix & changes",
    description: "Previewed, one-click-reversible writes to live client sites — no silent edits.",
    icon: BotIcon,
  },
  {
    code: "M19",
    title: "Client dashboard",
    description: "The agency-branded, white-label view — Visibility Score, share-of-voice, ROI.",
    icon: LayoutDashboardIcon,
  },
  {
    code: "M18",
    title: "Resource center",
    description: "A vertical-scoped, Claude-powered research aid for operators and clients.",
    icon: FileTextIcon,
  },
];

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-14 px-6 py-16">
      <section className="flex flex-col gap-4">
        <p className="font-mono text-xs tracking-[0.2em] text-muted uppercase">
          AEO/GEO + Brand Production OS
        </p>
        <h1 className="max-w-3xl font-display text-display text-ink">
          The intelligence instrument for an AI-native agency
        </h1>
        <p className="max-w-2xl text-base text-muted">
          AEO/GEO intelligence and brand-consistent production, driven by
          industry playbooks. Multi-tenant and white-label from commit one. This
          page tracks what&apos;s live and what&apos;s coming in Phase 1.
        </p>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="size-1.5 rounded-full bg-positive" />
          <h2 className="font-mono text-xs tracking-[0.18em] text-muted uppercase">
            Live now
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {LIVE.map((entry) => {
            const Icon = entry.icon;
            return (
              <Link
                key={entry.href}
                href={entry.href}
                className="group rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <Card className="h-full gap-4 py-5 transition-colors group-hover:border-accent">
                  <div className="flex flex-col gap-3 px-6">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex size-9 items-center justify-center rounded-lg bg-overlay">
                        <Icon aria-hidden className="size-5 text-accent" />
                      </span>
                      <Badge variant="secondary">Live</Badge>
                    </div>
                    <div className="flex flex-col gap-1">
                      <span className="flex items-center gap-1.5 font-medium text-ink">
                        {entry.title}
                        <ArrowRightIcon
                          aria-hidden
                          className="size-4 text-muted transition-transform group-hover:translate-x-0.5 group-hover:text-accent"
                        />
                      </span>
                      <span className="text-sm text-muted">
                        {entry.description}
                      </span>
                    </div>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon aria-hidden className="size-4 text-muted" />
          <h2 className="font-mono text-xs tracking-[0.18em] text-muted uppercase">
            Coming in Phase 1
          </h2>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {COMING.map((entry) => {
            const Icon = entry.icon;
            return (
              <Card key={entry.code} className="gap-3 py-5">
                <div className="flex flex-col gap-3 px-6">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex size-9 items-center justify-center rounded-lg bg-overlay">
                      <Icon aria-hidden className="size-5 text-muted" />
                    </span>
                    <Badge variant="outline" className="font-mono text-[10px] uppercase">
                      {entry.code} · soon
                    </Badge>
                  </div>
                  <div className="flex flex-col gap-1">
                    <span className="font-medium text-ink">{entry.title}</span>
                    <span className="text-sm text-muted">
                      {entry.description}
                    </span>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      <footer className="border-t pt-6">
        <p className="max-w-2xl text-xs leading-5 text-muted">
          Foundations are frozen (F1 data model · F2 design system). Feature UI
          builds only on the frozen system — no hardcoded brand values, every
          surface themeable per tenant.
        </p>
      </footer>
    </main>
  );
}
