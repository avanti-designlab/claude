/**
 * DESIGN PREVIEW primitive — a green/red ▲▼ delta as a soft WASH PILL
 * (operator direction, 2026-07-08 — the reference dashboards' stat badges).
 * Color is NEVER the only signal: the triangle glyph and a screen-reader word
 * carry the direction too (token-gate policy). Semantic green/red only —
 * never the brand accents, so "up/down" never reads as brand energy.
 *
 * The wash is color-mix over the positive/negative token. Because the pill
 * can sit on three different grounds across the pass-3 variants, `on` names
 * the ground and the numerals derive from tokens accordingly:
 *  - "chrome"     (default) — light cards AND the dark variant's navy tiles:
 *                  the gate already validated the semantic tokens against
 *                  both chrome layers, so the numerals wear them directly.
 *  - "deepFill"   — dark/filled tiles on the LIGHT chrome (navy/blue fills):
 *                  numerals are the semantic hue mixed toward the raised
 *                  surface (a light pastel), so contrast comes from tokens,
 *                  never a raw white assumption.
 *  - "brightFill" — light-cyan/blue fills on the DARK chrome (the reference
 *                  bubble): numerals mix toward the near-black surface token.
 */

import type { CSSProperties } from "react";
import { cn } from "@/lib/theme/utils";

export type DeltaGround = "chrome" | "deepFill" | "brightFill";

export interface DeltaProps {
  /** Signed change; sign picks direction + color, magnitude is shown. */
  value: number;
  /** Unit suffix, e.g. "%" or "pts". */
  unit?: string;
  /** Trailing context, e.g. "vs last run". */
  context?: string;
  /** Color class for the trailing context (override for dark/colored cards). */
  contextClassName?: string;
  /** Which ground the pill sits on (see module comment). */
  on?: DeltaGround;
  className?: string;
}

export function Delta({
  value,
  unit = "",
  context,
  contextClassName = "text-muted",
  on = "chrome",
  className,
}: DeltaProps) {
  const up = value >= 0;
  const tone = up ? "--positive" : "--negative";

  const pillStyle: CSSProperties = {
    background: `color-mix(in oklab, var(${tone}) ${on === "chrome" ? 13 : 26}%, transparent)`,
  };
  const numeralStyle: CSSProperties | undefined =
    on === "deepFill"
      ? { color: `color-mix(in oklab, var(${tone}) 45%, var(--surface-raised))` }
      : on === "brightFill"
        ? { color: `color-mix(in oklab, var(${tone}) 35%, var(--surface))` }
        : undefined;

  return (
    <span className={cn("inline-flex items-center gap-2 text-sm", className)}>
      <span
        style={pillStyle}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono tabular-nums",
          on === "chrome" && (up ? "text-positive" : "text-negative")
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
