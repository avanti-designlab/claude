/**
 * DESIGN PREVIEW primitive — a status/meta pill on a soft brand-color WASH
 * (operator direction, 2026-07-08: colorful pills, "not just white boxes").
 *
 * Every wash is a color-mix over a token (blue/orange/gold/positive/negative)
 * — never a literal. Text stays INK on the light washes (the contrast-safe
 * choice from the token gate); the tone is carried by the wash + a solid dot,
 * so color is never the only signal (the pill always has a text label).
 */

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/theme/utils";

export type WashPillTone = "blue" | "orange" | "gold" | "positive" | "negative";

const TONE_VAR: Record<WashPillTone, string> = {
  blue: "--accent",
  orange: "--accent-secondary",
  gold: "--accent-warm",
  positive: "--positive",
  negative: "--negative",
};

export interface WashPillProps {
  tone: WashPillTone;
  children: ReactNode;
  className?: string;
}

export function WashPill({ tone, children, className }: WashPillProps) {
  const style: CSSProperties = {
    background: `color-mix(in oklab, var(${TONE_VAR[tone]}) 15%, transparent)`,
  };
  return (
    <span
      style={style}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10px] tracking-wide text-ink uppercase",
        className
      )}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: `var(${TONE_VAR[tone]})` }}
      />
      {children}
    </span>
  );
}
