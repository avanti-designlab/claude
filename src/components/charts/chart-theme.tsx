"use client";

/**
 * The Recharts visual language, encoded once (F2, doc 06 §8.3).
 *
 * Every color is a design token (or a color-mix derivation of one) — a chart
 * never picks its own colors. The language:
 *
 * - Identity: the tenant accent marks "the client"; everything that is not
 *   the client recedes into neutral ink-mixes. There is deliberately NO
 *   multi-hue categorical ramp in F2 — the accent does the talking (doc 06
 *   §2). Adding one later is a design-system change (post-freeze sign-off).
 * - Status: positive/negative only, always paired with a glyph or label —
 *   color is never the only signal (token-gate policy).
 * - Chrome: quiet hairline grid (ink @ 8%), muted mono numerals for axes and
 *   values, raised-surface tooltip panel.
 * - Marks: 2px lines, slim bars with a rounded data-end, gradient washes
 *   instead of solid fills. The tokens sit brighter than a dark-mode
 *   categorical palette would (the accessibility gate requires >= 3:1 on
 *   both chrome layers), so marks stay thin and labels stay in text tokens.
 */

import type { TooltipContentProps } from "recharts";

/** Quiet structural strokes, derived from tokens at usage time. */
export const chartStroke = {
  grid: "color-mix(in oklab, var(--ink) 8%, transparent)",
  cursor: "color-mix(in oklab, var(--ink) 16%, transparent)",
  /** Neutral series fill for non-client entities (recedes behind accent). */
  neutralSeries: "color-mix(in oklab, var(--ink) 22%, transparent)",
} as const;

/** Axis tick styling: muted mono numerals, no tick lines. */
export const axisTick = {
  fill: "var(--muted)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
} as const;

export const AXIS_DEFAULTS = {
  tickLine: false,
  axisLine: false,
  tick: axisTick,
} as const;

interface TooltipRow {
  label: string;
  value: string;
}

function TooltipPanel({ title, rows }: { title?: string; rows: TooltipRow[] }) {
  return (
    <div className="rounded-md border bg-surface-raised px-3 py-2 shadow-lg">
      {title ? (
        <p className="mb-1 font-mono text-xs tracking-wide text-muted">{title}</p>
      ) : null}
      {rows.map((row) => (
        <p key={row.label} className="flex items-baseline justify-between gap-4 text-sm">
          <span className="text-muted">{row.label}</span>
          <span className="font-mono tabular-nums text-ink">{row.value}</span>
        </p>
      ))}
    </div>
  );
}

/**
 * Shared tooltip content for all Recharts wrappers: raised surface, muted
 * label, mono numeral — the same panel everywhere.
 */
export function ChartTooltip({
  active,
  payload,
  label,
  format,
}: Partial<Pick<TooltipContentProps<number, string>, "active" | "payload" | "label">> & {
  format?: (value: number) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const rows: TooltipRow[] = payload.map((entry) => ({
    label: String(entry.name ?? ""),
    value:
      typeof entry.value === "number"
        ? (format?.(entry.value) ?? String(entry.value))
        : String(entry.value ?? ""),
  }));
  return <TooltipPanel title={label === undefined ? undefined : String(label)} rows={rows} />;
}
