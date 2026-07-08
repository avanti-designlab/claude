/**
 * DESIGN PREVIEW primitive — a green/red ▲▼ delta as a soft WASH PILL
 * (operator direction, 2026-07-08 — the reference dashboards' stat badges).
 * Color is NEVER the only signal: the triangle glyph and a screen-reader word
 * carry the direction too (token-gate policy). Semantic green/red only —
 * never the brand accents, so "up/down" never reads as brand energy.
 *
 * The wash is color-mix over the positive/negative token. The pill can sit
 * on three grounds, and since the consolidation the filled grounds are
 * MODE-AWARE (the standard `dark:` mechanism flips the derivation with the
 * palette — no JS mode prop):
 *  - "chrome" (default) — quiet cards on either palette: the gate already
 *    validated the semantic tokens against both chrome layers, so the
 *    numerals wear them directly.
 *  - "glow"   — the glow stat bubble: light mode is a vivid blue/navy fill
 *    (numerals mix the semantic hue toward the raised surface — a light
 *    pastel); dark mode is the bright cyan→blue bubble (numerals mix toward
 *    the near-black surface token). Contrast always comes from tokens,
 *    never a raw white/black assumption.
 *  - "deep"   — the momentum depth tile: a navy (ink) fill in light mode
 *    (pastel numerals), a quiet navy card in dark mode (chrome treatment).
 */

import { cn } from "@/lib/theme/utils";

export type DeltaGround = "chrome" | "glow" | "deep";

/**
 * Per-ground, per-direction class sets. Full literal strings (Tailwind scans
 * statically); every value is a token derivation.
 */
const PILL: Record<DeltaGround, Record<"up" | "down", string>> = {
  chrome: {
    up: "bg-positive/13 text-positive",
    down: "bg-negative/13 text-negative",
  },
  glow: {
    up: "bg-positive/26 text-[color-mix(in_oklab,var(--positive)_45%,var(--surface-raised))] dark:text-[color-mix(in_oklab,var(--positive)_35%,var(--surface))]",
    down: "bg-negative/26 text-[color-mix(in_oklab,var(--negative)_45%,var(--surface-raised))] dark:text-[color-mix(in_oklab,var(--negative)_35%,var(--surface))]",
  },
  deep: {
    up: "bg-positive/26 dark:bg-positive/13 text-[color-mix(in_oklab,var(--positive)_45%,var(--surface-raised))] dark:text-positive",
    down: "bg-negative/26 dark:bg-negative/13 text-[color-mix(in_oklab,var(--negative)_45%,var(--surface-raised))] dark:text-negative",
  },
};

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

  return (
    <span className={cn("inline-flex items-center gap-2 text-sm", className)}>
      <span
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono tabular-nums",
          PILL[on][up ? "up" : "down"]
        )}
      >
        <span aria-hidden className="text-[0.7em] leading-none">
          {up ? "▲" : "▼"}
        </span>
        <span className="sr-only">{up ? "up" : "down"}</span>
        <span>
          {up ? "+" : "−"}
          {Math.abs(value)}
          {unit}
        </span>
      </span>
      {context ? <span className={contextClassName}>{context}</span> : null}
    </span>
  );
}
