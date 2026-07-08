/**
 * DESIGN PREVIEW — an insight/stat tile. BIG + BOLD: the number uses the
 * display face at full bold on the frozen `--text-display` step and counts up
 * on load (reduced-motion renders the final value instantly — same contract
 * as the Visibility resolve).
 *
 * Pass-3 tones (operator direction, 2026-07-08 — the BLUE-DEPTH system;
 * Core Orange/Alachua are OFF this page):
 *  - "plain" — quiet raised tile (kept calm so the showcase pops).
 *  - "sky"   — a soft highlight-cyan wash over the raised surface.
 *  - "glow"  — THE showcase: the illuminated bubble (GlowCard). On the light
 *              chrome it is a vivid-blue→navy gradient with the derived
 *              on-accent foreground; on the dark chrome it is the reference
 *              light-cyan→blue bubble with near-black (surface-token) text.
 *
 * Text on filled tiles uses DERIVED foregrounds or the opposing surface
 * tokens — never a raw white/black assumption. Tone specs are authored per
 * variant because token polarity flips between chromes; every value is still
 * a token derivation.
 */

import { cn } from "@/lib/theme/utils";
import type { BlueDepthVariant } from "@/lib/theme/operator-theme";
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
  /** Which pass-3 chrome the tile sits on (fills/foregrounds flip with it). */
  variant: BlueDepthVariant;
  className?: string;
}

interface ToneSpec {
  /** Inline background (token wash) applied via style — non-glow tones only. */
  background?: string;
  /** Container text/border classes. */
  card: string;
  label: string;
  value: string;
  unit: string;
  /** Muted context text on this tone (delta context). */
  context: string;
  arrow: ArrowButtonTone;
  /** A small accent chip color that gives the tone a meaning cue. */
  chip: string;
  /** Sparkline bar colors (CSS color strings over tokens). */
  spark: { bar: string; last: string };
  /** Which ground the delta pill sits on. */
  delta: DeltaGround;
}

function toneSpec(tone: StatTone, variant: BlueDepthVariant): ToneSpec {
  if (tone === "plain") {
    return {
      card: "border border-border bg-surface-raised text-ink shadow-sm",
      label: "text-muted",
      value: "text-ink",
      unit: "text-muted",
      context: "text-muted",
      arrow: "ink",
      chip: "var(--muted)",
      spark: {
        bar: "color-mix(in oklab, var(--accent) 30%, transparent)",
        last: "var(--accent)",
      },
      delta: "chrome",
    };
  }
  if (tone === "sky") {
    return {
      background:
        "linear-gradient(135deg, color-mix(in oklab, var(--accent-secondary) 14%, var(--surface-raised)), var(--surface-raised) 70%)",
      card: "border border-transparent text-ink shadow-sm",
      label: "text-muted",
      value: "text-ink",
      unit: "text-muted",
      context: "text-muted",
      arrow: "ink",
      chip: "var(--accent-secondary)",
      spark: {
        bar: "color-mix(in oklab, var(--accent-secondary) 45%, transparent)",
        last: "var(--accent-secondary)",
      },
      delta: "chrome",
    };
  }
  // "glow" — the illuminated showcase bubble.
  return variant === "dark"
    ? {
        // Bright cyan→blue fill: near-black surface-token foregrounds.
        card: "text-surface",
        label: "text-surface/75",
        value: "text-surface",
        unit: "text-surface/75",
        context: "text-surface/70",
        arrow: "onBright",
        chip: "color-mix(in oklab, var(--surface) 75%, transparent)",
        spark: {
          bar: "color-mix(in oklab, var(--surface) 45%, transparent)",
          last: "var(--surface)",
        },
        delta: "brightFill",
      }
    : {
        // Vivid blue→navy fill: derived on-accent foregrounds.
        card: "text-accent-foreground",
        label: "text-accent-foreground/75",
        value: "text-accent-foreground",
        unit: "text-accent-foreground/75",
        context: "text-accent-foreground/70",
        arrow: "onColor",
        chip: "color-mix(in oklab, var(--accent-foreground) 80%, transparent)",
        spark: {
          bar: "color-mix(in oklab, var(--accent-foreground) 40%, transparent)",
          last: "var(--accent-foreground)",
        },
        delta: "deepFill",
      };
}

/** Decorative rounded bar sparkline (ref: the filled stat tile's bars). */
function Sparkline({ values, spec }: { values: number[]; spec: ToneSpec }) {
  const max = Math.max(...values, 1);
  return (
    <div aria-hidden className="flex h-9 items-end gap-1">
      {values.map((v, i) => (
        <span
          key={i}
          className="w-1.5 rounded-full"
          style={{
            height: `${Math.max(12, (v / max) * 100)}%`,
            background: i === values.length - 1 ? spec.spark.last : spec.spark.bar,
          }}
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
  variant,
  className,
}: StatCardProps) {
  const spec = toneSpec(tone, variant);

  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p
          className={cn(
            "flex items-center gap-2 font-mono text-[11px] tracking-[0.16em] uppercase",
            spec.label
          )}
        >
          <span
            aria-hidden
            className="size-1.5 rounded-full"
            style={{ background: spec.chip }}
          />
          {label}
        </p>
        <ArrowButton label={`View ${label}`} size="sm" tone={spec.arrow} />
      </div>

      <div className="flex items-end justify-between gap-3">
        <span className="flex items-baseline gap-1.5">
          <CountUpValue
            value={value}
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
        variant={variant}
        surface="bubble"
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
        className
      )}
      style={spec.background ? { background: spec.background } : undefined}
    >
      {inner}
    </div>
  );
}
