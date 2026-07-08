/**
 * DESIGN PREVIEW primitive — the signature "black circular arrow button (↗)".
 * Token-driven: the "black" is the ink token (a Dark-Blue-tinted near-black
 * under the operator theme), the glyph is the surface token — so it re-skins
 * per tenant like everything else.
 *
 * Tones (each hover is a FILL-INVERT — operator direction, 2026-07-08):
 *  - "ink"     — dark circle on light chrome → inverts to a light circle with
 *                an ink glyph and a visible ink border.
 *  - "accent"  — Core Blue fill → inverts to a raised-surface circle with the
 *                accent glyph.
 *  - "onColor" — frosted translucent circle for dark/colored panels → inverts
 *                to a SOLID raised-surface circle with an ink glyph.
 *  - "surface" — solid raised-surface (white) circle for colored panels →
 *                inverts to an ink circle with a light glyph.
 *
 * Interactive: motion-safe lift/scale + an arrow nudge on hover, scale-down on
 * press, 200ms ease. Reduced motion keeps every transform off; the visible
 * focus ring is always present. On-color text uses derived foregrounds or the
 * surface tokens — never a raw white assumption.
 *
 * Not a frozen component-library primitive; it lives with the dashboard preview
 * (a visual target M19 will match), not in src/components/ui.
 */

import { ArrowUpRightIcon } from "lucide-react";
import { cn } from "@/lib/theme/utils";

export type ArrowButtonTone =
  | "ink"
  | "accent"
  | "onColor"
  | "onBright"
  | "onGlow"
  | "surface"
  | "negative";
export type ArrowButtonSize = "sm" | "md" | "lg";

const TONE: Record<ArrowButtonTone, string> = {
  ink: "border border-transparent bg-ink text-surface hover:border-ink/30 hover:bg-surface hover:text-ink hover:shadow-md",
  accent:
    "border border-transparent bg-accent text-accent-foreground hover:border-accent/40 hover:bg-surface-raised hover:text-accent hover:shadow-md",
  onColor:
    "border border-transparent bg-surface-raised/18 text-surface-raised hover:bg-surface-raised hover:text-ink hover:shadow-md",
  /** Frosted dark circle for BRIGHT fills (the pass-3 cyan bubble on the dark chrome). */
  onBright:
    "border border-transparent bg-surface/20 text-surface hover:bg-surface hover:text-ink hover:shadow-md",
  /**
   * MODE-AWARE tone for the glow bubble (working brand v1): the bubble is a
   * vivid-blue fill in light mode (frosted light circle) and the bright
   * cyan→blue fill in dark mode (frosted dark circle). Rides the standard
   * mode mechanism (`dark:` variant) — no JS mode prop.
   */
  onGlow:
    "border border-transparent bg-surface-raised/18 text-surface-raised hover:bg-surface-raised hover:text-ink hover:shadow-md " +
    "dark:bg-surface/20 dark:text-surface dark:hover:bg-surface dark:hover:text-ink",
  surface:
    "border border-transparent bg-surface-raised text-ink hover:bg-ink hover:text-surface-raised hover:shadow-lg",
  /** Urgency (pass-3 "needs fixing" zone) — semantic negative, never orange. */
  negative:
    "border border-transparent bg-negative text-negative-foreground hover:border-negative/40 hover:bg-surface-raised hover:text-negative hover:shadow-md",
};

const SIZE: Record<ArrowButtonSize, { button: string; icon: string }> = {
  sm: { button: "size-7", icon: "size-3.5" },
  md: { button: "size-9", icon: "size-4" },
  lg: { button: "size-12", icon: "size-5" },
};

export interface ArrowButtonProps {
  label: string;
  tone?: ArrowButtonTone;
  size?: ArrowButtonSize;
  className?: string;
}

export function ArrowButton({
  label,
  tone = "ink",
  size = "md",
  className,
}: ArrowButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "group/arrow inline-flex shrink-0 items-center justify-center rounded-full outline-none",
        "transition-[transform,box-shadow,background-color,color,border-color] duration-200",
        "motion-safe:hover:-translate-y-0.5 motion-safe:hover:scale-105 motion-safe:active:scale-95",
        "focus-visible:ring-[3px] focus-visible:ring-ring/50",
        (tone === "onColor" || tone === "surface" || tone === "onGlow") &&
          "focus-visible:ring-surface-raised/60",
        TONE[tone],
        SIZE[size].button,
        className
      )}
    >
      <ArrowUpRightIcon
        className={cn(
          SIZE[size].icon,
          "transition-transform duration-200",
          "motion-safe:group-hover/arrow:translate-x-px motion-safe:group-hover/arrow:-translate-y-px"
        )}
        strokeWidth={2.25}
      />
    </button>
  );
}
