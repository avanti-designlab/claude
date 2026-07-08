/**
 * DESIGN PREVIEW — share-of-voice vs named competitors in the operator's
 * Spendex craft: pill-shaped bars with speech-bubble value labels. Identity
 * through the accent (the client's pill + bubble wear Core Blue; competitors
 * recede into a neutral ink wash) — the same "the accent follows the client"
 * rule as the frozen ShareOfVoice chart, restyled for the preview target.
 *
 * Static + token-driven; a chart never picks its own colors.
 *
 * Interactive (operator direction, 2026-07-08): hovering a row highlights it
 * (an overlay-token wash), sharpens the competitor name, and gives the value
 * bubble a motion-safe emphasis — transform is gated by motion-safe, and the
 * highlight is a 200ms color transition that reads instantly either way.
 */

import { cn } from "@/lib/theme/utils";

export interface PillBarEntry {
  name: string;
  /** Share of voice, 0–100 (%). */
  share: number;
  isClient?: boolean;
}

export interface PillBarsProps {
  data: PillBarEntry[];
  className?: string;
}

export function PillBars({ data, className }: PillBarsProps) {
  const max = Math.max(...data.map((d) => d.share), 1);

  return (
    <ul className={cn("flex flex-col gap-3.5", className)}>
      {data.map((entry) => {
        const width = `${(entry.share / max) * 100}%`;
        return (
          <li
            key={entry.name}
            className="group/row -mx-2 grid grid-cols-[8rem_1fr_3.75rem] items-center gap-4 rounded-lg px-2 py-1 transition-colors duration-200 hover:bg-overlay"
          >
            <span
              className={cn(
                "truncate text-sm transition-colors duration-200",
                entry.isClient
                  ? "font-medium text-ink"
                  : "text-muted group-hover/row:text-ink"
              )}
            >
              {entry.name}
            </span>

            {/* Pill bar track + fill */}
            <span
              className="relative block h-3.5 w-full rounded-full"
              style={{ background: "color-mix(in oklab, var(--ink) 7%, transparent)" }}
            >
              <span
                className={cn("absolute inset-y-0 left-0 rounded-full", entry.isClient && "bg-accent")}
                style={{
                  width,
                  background: entry.isClient
                    ? undefined
                    : "color-mix(in oklab, var(--ink) 26%, transparent)",
                }}
              />
            </span>

            {/* Speech-bubble value label with a left-pointing tail */}
            <span
              className={cn(
                "relative inline-flex items-center justify-center rounded-lg px-2 py-1 font-mono text-xs tabular-nums",
                "transition-[transform,box-shadow] duration-200 group-hover/row:shadow-md motion-safe:group-hover/row:scale-110",
                entry.isClient
                  ? "bg-accent text-accent-foreground"
                  : "bg-ink text-surface"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "absolute top-1/2 left-0 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px]",
                  entry.isClient ? "bg-accent" : "bg-ink"
                )}
              />
              {entry.share}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}
