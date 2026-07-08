/**
 * DESIGN PREVIEW primitive — the signature "black circular arrow button (↗)"
 * from the operator's Spendex reference. Token-driven: the "black" is the ink
 * token (a Dark-Blue-tinted near-black under the operator theme), the glyph is
 * the surface token — so it re-skins per tenant like everything else.
 *
 * Not a frozen component-library primitive; it lives with the dashboard preview
 * (a visual target M19 will match), not in src/components/ui.
 */

import { ArrowUpRightIcon } from "lucide-react";
import { cn } from "@/lib/theme/utils";

export interface ArrowButtonProps {
  label: string;
  /** Accent-filled variant (Core Blue) instead of the default ink circle. */
  tone?: "ink" | "accent";
  size?: "sm" | "md";
  className?: string;
}

export function ArrowButton({ label, tone = "ink", size = "md", className }: ArrowButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full outline-none transition-transform",
        "hover:-translate-y-0.5 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        tone === "ink"
          ? "bg-ink text-surface"
          : "bg-accent text-accent-foreground",
        size === "md" ? "size-9" : "size-7",
        className
      )}
    >
      <ArrowUpRightIcon className={size === "md" ? "size-4" : "size-3.5"} strokeWidth={2.25} />
    </button>
  );
}
