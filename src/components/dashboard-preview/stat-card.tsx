/**
 * DESIGN PREVIEW — an insight/stat tile. BIG + BOLD (operator direction,
 * 2026-07-08): the number uses the display face at full bold on the frozen
 * `--text-display` step, and counts up on load (reduced-motion renders the
 * final value instantly — same contract as the Visibility resolve).
 *
 * Tones make the tile grid read as color RHYTHM rather than "all white boxes"
 * — every tone is a token wash/gradient, never a literal:
 *  - "plain"  — white supporting tile (kept light so the colored ones pop).
 *  - "gold"   — soft Alachua wash.
 *  - "orange" — soft Core Orange wash.
 *  - "blue"   — FILLED Core Blue gradient (90° per the brand guide), on-color
 *               foreground text + light sparkline — the reference's dark
 *               filled stat tile, in our blue.
 *  - "dark"   — ink navy filled tile, light number (depth/contrast).
 *
 * Text on the filled tiles uses the DERIVED foregrounds (--accent-foreground)
 * or the opposing surface tokens — never a raw white assumption. Lively but
 * disciplined: hover lift + shadow (motion-safe only) and a circular ↗ whose
 * hover is a fill-invert. Delta stays semantic green/red.
 */

import { cn } from "@/lib/theme/utils";
import { ArrowButton, type ArrowButtonTone } from "./arrow-button";
import { CountUpValue } from "./count-up";
import { Delta } from "./delta";

export type StatTone = "plain" | "blue" | "gold" | "orange" | "dark";

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
  className?: string;
}

interface ToneSpec {
  /** Inline background (token wash/gradient) applied via style. */
  background?: string;
  /** True for the filled (blue/dark) tiles — flips delta + context colors. */
  filled?: boolean;
  /** Card border + text classes. */
  card: string;
  label: string;
  value: string;
  unit: string;
  /** Muted context text on this tone (delta context). */
  context: string;
  /** ↗ button tone. */
  arrow: ArrowButtonTone;
  /** A small accent chip color that gives the tone a meaning cue. */
  chip: string;
  /** Sparkline bar colors (CSS color strings over tokens). */
  spark: { bar: string; last: string };
}

const TONE: Record<StatTone, ToneSpec> = {
  plain: {
    card: "border-border text-ink",
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
  },
  blue: {
    // FILLED Core Blue — 90° gradient per the brand guide, plus a soft sheen.
    background:
      "radial-gradient(120% 140% at 100% 0%, color-mix(in oklab, var(--surface-raised) 18%, transparent), transparent 55%), linear-gradient(90deg, var(--accent), color-mix(in oklab, var(--accent) 58%, var(--ink)))",
    filled: true,
    card: "border-transparent text-accent-foreground",
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
  },
  gold: {
    background:
      "linear-gradient(135deg, color-mix(in oklab, var(--accent-warm) 16%, var(--surface-raised)), var(--surface-raised))",
    card: "border-transparent text-ink",
    label: "text-muted",
    value: "text-ink",
    unit: "text-muted",
    context: "text-muted",
    arrow: "ink",
    chip: "var(--accent-warm)",
    spark: {
      bar: "color-mix(in oklab, var(--accent-warm) 45%, transparent)",
      last: "var(--accent-warm)",
    },
  },
  orange: {
    background:
      "linear-gradient(135deg, color-mix(in oklab, var(--accent-secondary) 12%, var(--surface-raised)), var(--surface-raised))",
    card: "border-transparent text-ink",
    label: "text-muted",
    value: "text-ink",
    unit: "text-muted",
    context: "text-muted",
    arrow: "ink",
    chip: "var(--accent-secondary)",
    spark: {
      bar: "color-mix(in oklab, var(--accent-secondary) 40%, transparent)",
      last: "var(--accent-secondary)",
    },
  },
  dark: {
    background:
      "radial-gradient(120% 130% at 100% 0%, color-mix(in oklab, var(--accent) 34%, transparent), transparent 62%), linear-gradient(140deg, var(--ink), color-mix(in oklab, var(--ink) 82%, var(--accent)))",
    filled: true,
    card: "border-transparent text-surface-raised",
    label: "text-surface-raised/70",
    value: "text-surface-raised",
    unit: "text-surface-raised/75",
    context: "text-surface-raised/70",
    arrow: "onColor",
    chip: "color-mix(in oklab, var(--surface-raised) 70%, transparent)",
    spark: {
      bar: "color-mix(in oklab, var(--surface-raised) 40%, transparent)",
      last: "var(--surface-raised)",
    },
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
  className,
}: StatCardProps) {
  const spec = TONE[tone];
  return (
    <div
      className={cn(
        "group flex flex-col gap-4 rounded-xl border p-5 shadow-sm transition-[transform,box-shadow] duration-200",
        "hover:shadow-lg motion-safe:hover:-translate-y-1",
        spec.card,
        !spec.background && "bg-surface-raised",
        className
      )}
      style={spec.background ? { background: spec.background } : undefined}
    >
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
              "font-display text-display leading-none font-bold tabular-nums",
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
          onColor={spec.filled}
          contextClassName={spec.context}
        />
      ) : null}
    </div>
  );
}
