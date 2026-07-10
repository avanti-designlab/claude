import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRightIcon, RadarIcon } from "lucide-react";

import { WashPill } from "@/components/dashboard-preview";

/**
 * Honest pending states for dashboard modules with NO real data source yet
 * (HONESTY RULE: the live dashboard never shows a fake number — a module
 * either renders real workspace data or says exactly why it can't). These are
 * deliberately QUIET — dashed borders, muted tones, no glow, no animation —
 * so a pending module never competes with real data for attention.
 */

/**
 * A signal tile: which intelligence signal, why it has no number yet, and —
 * when the surface it lives on is already live — a quiet link to it. The view
 * is built; it fills with real data once a client's property is connected and
 * tracking runs. Server-safe (pure markup) — used in the intelligence-signals
 * strip.
 */
export function PendingModuleCard({
  icon: Icon,
  title,
  description,
  link,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  /** A live surface where this signal lives, once data is connected. */
  link?: { href: string; label: string };
}) {
  return (
    <div className="flex h-full items-start gap-3 rounded-lg border border-dashed border-border p-4">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-overlay"
      >
        <Icon className="size-4 text-muted" strokeWidth={2} />
      </span>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{title}</span>
          <WashPill tone="gold">Not connected yet</WashPill>
        </div>
        <p className="text-xs leading-5 text-muted">{description}</p>
        {link ? (
          <Link
            href={link.href}
            className="mt-0.5 inline-flex w-fit items-center gap-1 rounded text-xs font-medium text-accent underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {link.label}
            <ArrowRightIcon aria-hidden className="size-3" strokeWidth={2} />
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The Visibility Score's pending state, shaped like the gauge it will become
 * (a dashed ring where the resolve moment will live) so the hero composition
 * matches the approved preview without inventing a score. Foregrounds are the
 * hero card's MODE-AWARE treatment: derived on-accent tokens on the light
 * mode's vivid-blue fill, ink/muted on the dark mode's navy fill — pure token
 * choices, same as the preview's HERO classes.
 */
export function PendingGauge() {
  return (
    <div className="flex max-w-[15rem] flex-col items-center gap-3 text-center">
      <span
        aria-hidden
        className="flex size-36 items-center justify-center rounded-full border-2 border-dashed border-accent-foreground/30 sm:size-40 dark:border-ink/25"
      >
        <RadarIcon
          className="size-8 text-accent-foreground/70 dark:text-muted"
          strokeWidth={1.75}
        />
      </span>
      <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-accent-foreground/85 dark:text-ink/85">
        Visibility Score
      </p>
      <p className="text-xs leading-5 text-accent-foreground/70 dark:text-muted">
        Not connected yet — the score resolves here once you connect a client&apos;s
        site and run a visibility check.
      </p>
    </div>
  );
}
