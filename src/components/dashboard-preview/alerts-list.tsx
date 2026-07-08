/**
 * DESIGN PREVIEW — a compact alerts / open-tasks feed (doc 06 §5). Outlined
 * line-icons, soft token-tinted icon wells, a black circular ↗ per row. Tone
 * is token-driven and always paired with an icon + label (color is never the
 * only signal).
 */

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/theme/utils";
import { ArrowButton } from "./arrow-button";

export type AlertTone = "accent" | "positive" | "negative" | "warm";

export interface AlertItem {
  icon: LucideIcon;
  title: string;
  meta: string;
  tone: AlertTone;
}

export interface AlertsListProps {
  items: AlertItem[];
  className?: string;
}

const TONE: Record<AlertTone, { well: string; icon: string }> = {
  accent: { well: "color-mix(in oklab, var(--accent) 12%, transparent)", icon: "text-accent" },
  positive: { well: "color-mix(in oklab, var(--positive) 14%, transparent)", icon: "text-positive" },
  negative: { well: "color-mix(in oklab, var(--negative) 14%, transparent)", icon: "text-negative" },
  warm: { well: "color-mix(in oklab, var(--accent-warm) 16%, transparent)", icon: "text-accent-warm" },
};

export function AlertsList({ items, className }: AlertsListProps) {
  return (
    <ul className={cn("flex flex-col", className)}>
      {items.map(({ icon: Icon, title, meta, tone }, index) => (
        <li
          key={title}
          className={cn(
            "flex items-center gap-3 py-3",
            index > 0 && "border-t border-border"
          )}
        >
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-full"
            style={{ background: TONE[tone].well }}
          >
            <Icon className={cn("size-4", TONE[tone].icon)} strokeWidth={2} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-ink">{title}</span>
            <span className="block truncate font-mono text-xs text-muted">{meta}</span>
          </span>
          <ArrowButton label={`Open: ${title}`} size="sm" />
        </li>
      ))}
    </ul>
  );
}
