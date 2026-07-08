/**
 * DESIGN PREVIEW primitive — a green/red ▲▼ delta as a soft WASH PILL
 * (operator direction, 2026-07-08 — the reference dashboards' stat badges).
 * Color is NEVER the only signal: the triangle glyph and a screen-reader word
 * carry the direction too (token-gate policy). Semantic green/red only —
 * never the brand accents, so "up/down" never reads as brand energy.
 *
 * The wash is color-mix over the positive/negative token; on light chrome the
 * numerals keep the semantic token color (gate-validated against the light
 * surfaces), and on dark/filled tiles (`onColor`) they shift to a token-derived
 * pastel — the semantic hue mixed toward the raised surface — so contrast on
 * the dark fill comes from the token layer, never a raw white assumption.
 */

import type { CSSProperties } from "react";
import { cn } from "@/lib/theme/utils";

export interface DeltaProps {
  /** Signed change; sign picks direction + color, magnitude is shown. */
  value: number;
  /** Unit suffix, e.g. "%" or "pts". */
  unit?: string;
  /** Trailing context, e.g. "vs last run". */
  context?: string;
  /** Color class for the trailing context (override for dark/colored cards). */
  contextClassName?: string;
  /** Set on dark/filled tiles: stronger wash + light-tinted numerals. */
  onColor?: boolean;
  className?: string;
}

export function Delta({
  value,
  unit = "",
  context,
  contextClassName = "text-muted",
  onColor = false,
  className,
}: DeltaProps) {
  const up = value >= 0;
  const tone = up ? "--positive" : "--negative";

  const pillStyle: CSSProperties = {
    background: `color-mix(in oklab, var(${tone}) ${onColor ? 26 : 13}%, transparent)`,
  };
  const numeralStyle: CSSProperties | undefined = onColor
    ? { color: `color-mix(in oklab, var(${tone}) 45%, var(--surface-raised))` }
    : undefined;

  return (
    <span className={cn("inline-flex items-center gap-2 text-sm", className)}>
      <span
        style={pillStyle}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono tabular-nums",
          !onColor && (up ? "text-positive" : "text-negative")
        )}
      >
        <span aria-hidden className="text-[0.7em] leading-none" style={numeralStyle}>
          {up ? "▲" : "▼"}
        </span>
        <span className="sr-only">{up ? "up" : "down"}</span>
        <span style={numeralStyle}>
          {up ? "+" : "−"}
          {Math.abs(value)}
          {unit}
        </span>
      </span>
      {context ? <span className={contextClassName}>{context}</span> : null}
    </span>
  );
}
