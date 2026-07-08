/**
 * DESIGN PREVIEW primitive — a green/red ▲▼ delta. Color is NEVER the only
 * signal: the triangle glyph and a screen-reader word carry the direction too
 * (token-gate policy). Semantic green/red only — never the brand accents, so
 * "up/down" never gets confused with brand energy.
 */

import { cn } from "@/lib/theme/utils";

export interface DeltaProps {
  /** Signed change; sign picks direction + color, magnitude is shown. */
  value: number;
  /** Unit suffix, e.g. "%" or "pts". */
  unit?: string;
  /** Trailing context, e.g. "vs last run". */
  context?: string;
  className?: string;
}

export function Delta({ value, unit = "", context, className }: DeltaProps) {
  const up = value >= 0;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm", className)}>
      <span
        className={cn(
          "inline-flex items-center gap-1 font-mono tabular-nums",
          up ? "text-positive" : "text-negative"
        )}
      >
        <span aria-hidden className="text-[0.7em] leading-none">
          {up ? "▲" : "▼"}
        </span>
        <span className="sr-only">{up ? "up" : "down"}</span>
        {up ? "+" : "−"}
        {Math.abs(value)}
        {unit}
      </span>
      {context ? <span className="text-muted">{context}</span> : null}
    </span>
  );
}
