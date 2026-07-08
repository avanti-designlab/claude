/**
 * DESIGN PREVIEW — an insight/stat tile. BIG + BOLD: the number uses the
 * display face at full bold on the frozen `--text-display` step and counts up
 * on load (reduced-motion renders the final value instantly — same contract
 * as the Visibility resolve). Pass `countDelay` (ms) to sequence the count-up
 * after the tile's entrance (`counterDelayMs`).
 *
 * Tones (working brand v1 — the BLUE-DEPTH system):
 *  - "plain" — quiet raised tile (kept calm so the showcase pops).
 *  - "sky"   — a soft highlight-cyan wash over the raised surface.
 *  - "glow"  — THE showcase: the illuminated bubble (GlowCard). MODE-AWARE
 *              via the standard `dark:` mechanism: in light mode a vivid
 *              blue→navy gradient with the derived on-accent foreground; in
 *              dark mode the reference light-cyan→blue bubble with
 *              near-black (surface-token) text. No JS mode prop.
 *
 * Text on filled tiles uses DERIVED foregrounds or the opposing surface
 * tokens — never a raw white/black assumption; every value is a token
 * derivation, so the tile re-skins per tenant.
 */

import { cn } from "@/lib/theme/utils";
import { ArrowButton, type ArrowButtonTone } from "./arrow-button";
import { CountUpValue } from "./count-up";
import { Delta, type DeltaGround } from "./delta";
import { GlowCard } from "./glow-card";

export type StatTone = "plain" | "sky" | "glow";

export interface StatCardProps {
  label: string;
  /** The big value, pre-formatted (e.g. "34%", "3,412", "#2"). */
  value: string;
  unit?: string;
  delta?: { value: number; unit?: string; context?: string };
  /**
   * Optional mini bar-sparkline values (relative heights). Decorative — the
   * value + delta carry the information, so it is aria-hidden and static.
   */
  sparkline?: number[];
  tone?: StatTone;
  /** Count-up start delay in ms (entrance sequencing). */
  countDelay?: number;
  /** Let the glow tile's bloom join the entrance choreography. */
  bloom?: boolean;
  className?: string;
}

interface ToneSpec {
  /** Non-glow tones: token-wash background classes on the tile. */
  surface?: string;
  /** Container text/border classes. */
  card: string;
  label: string;
  value: string;
  unit: string;
  /** Muted context text on this tone (delta context). */
  context: string;
  arrow: ArrowButtonTone;
  /** A small accent chip that gives the tone a meaning cue (classes). */
  chip: string;
  /** Sparkline bar classes. */
  spark: { bar: string; last: string };
  /** Which ground the delta pill sits on. */
  delta: DeltaGround;
}

const TONES: Record<StatTone, ToneSpec> = {
  plain: {
    card: "border border-border bg-surface-raised text-ink shadow-sm",
    label: "text-muted",
    value: "text-ink",
    unit: "text-muted",
    context: "text-muted",
    arrow: "ink",
    chip: "bg-muted",
    spark: { bar: "bg-accent/30", last: "bg-accent" },
    delta: "chrome",
  },
  sky: {
    surface:
      "[background:linear-gradient(135deg,color-mix(in_oklab,var(--accent-secondary)_14%,var(--surface-raised)),var(--surface-raised)_70%)]",
    card: "border border-transparent text-ink shadow-sm",
    label: "text-muted",
    value: "text-ink",
    unit: "text-muted",
    context: "text-muted",
    arrow: "ink",
    chip: "bg-accent-secondary",
    spark: { bar: "bg-accent-secondary/45", last: "bg-accent-secondary" },
    delta: "chrome",
  },
  // "glow" — the illuminated showcase bubble; foregrounds flip with the mode.
  glow: {
    card: "text-accent-foreground dark:text-surface",
    label: "text-accent-foreground/75 dark:text-surface/75",
    value: "text-accent-foreground dark:text-surface",
    unit: "text-accent-foreground/75 dark:text-surface/75",
    context: "text-accent-foreground/70 dark:text-surface/70",
    arrow: "onGlow",
    chip: "bg-accent-foreground/80 dark:bg-surface/75",
    spark: {
      bar: "bg-accent-foreground/40 dark:bg-surface/45",
      last: "bg-accent-foreground dark:bg-surface",
    },
    delta: "glow",
  },
};

/** Decorative rounded bar sparkline (ref: the filled stat tile's bars). */
function Sparkline({ values, spec }: { values: number[]; spec: ToneSpec }) {
  const max = Math.max(...values, 1);
  return (
    <div aria-hidden className="flex h-9 items-end gap-1">
      {values.map((v, i) => (
        <span
          key={i}
          className={cn(
            "w-1.5 rounded-full",
            i === values.length - 1 ? spec.spark.last : spec.spark.bar
          )}
          style={{ height: `${Math.max(12, (v / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function StatCard({
  label,
  value,
  unit,
  delta,
  sparkline,
  tone = "plain",
  countDelay = 0,
  bloom = false,
  className,
}: StatCardProps) {
  const spec = TONES[tone];

  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p
          className={cn(
            "flex items-center gap-2 font-mono text-[11px] tracking-[0.16em] uppercase",
            spec.label
          )}
        >
          <span aria-hidden className={cn("size-1.5 rounded-full", spec.chip)} />
          {label}
        </p>
        <ArrowButton label={`View ${label}`} size="sm" tone={spec.arrow} />
      </div>

      <div className="flex items-end justify-between gap-3">
        <span className="flex items-baseline gap-1.5">
          <CountUpValue
            value={value}
            delay={countDelay}
            className={cn(
              "font-display text-display leading-none font-bold tracking-tight tabular-nums",
              spec.value
            )}
          />
          {unit ? (
            <span className={cn("font-mono text-sm", spec.unit)}>{unit}</span>
          ) : null}
        </span>
        {sparkline?.length ? <Sparkline values={sparkline} spec={spec} /> : null}
      </div>

      {delta ? (
        <Delta
          value={delta.value}
          unit={delta.unit}
          context={delta.context}
          on={spec.delta}
          contextClassName={spec.context}
        />
      ) : null}
    </>
  );

  const layout = "group flex flex-col gap-4 p-5";
  const motionCls =
    "transition-transform duration-200 motion-safe:hover:-translate-y-1";

  if (tone === "glow") {
    return (
      <GlowCard
        surface="bubble"
        bloom={bloom}
        className={cn(layout, motionCls, spec.card, className)}
      >
        {inner}
      </GlowCard>
    );
  }

  return (
    <div
      className={cn(
        "rounded-[calc(var(--radius)*3)]",
        layout,
        "transition-[transform,box-shadow] duration-200 hover:shadow-lg motion-safe:hover:-translate-y-1",
        spec.card,
        spec.surface,
        className
      )}
    >
      {inner}
    </div>
  );
}
