"use client";

/**
 * EngineCitations — per-engine citation status grid (doc 06 §5: tracker
 * results, dashboard hero support).
 *
 * Status encoding uses the reserved status tokens (positive/negative) plus
 * muted for "not cited", and ALWAYS pairs the color with a glyph and a text
 * label — color is never the only signal. This is a status display, not a
 * quantity chart, so it is a component, not a Recharts plot (the dataviz
 * rule: "is it even a chart?").
 */

import { CheckIcon, MinusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/theme/utils";

export type CitationStatus = "cited" | "lost" | "missing";

export interface EngineCitation {
  /** Engine name, e.g. "ChatGPT", "Perplexity", "Google AI Overviews". */
  engine: string;
  status: CitationStatus;
  /** Optional short detail, e.g. "3 citations" or "dropped Jun 30". */
  detail?: string;
}

export interface EngineCitationsProps {
  data: EngineCitation[];
  className?: string;
}

const STATUS_SPEC: Record<
  CitationStatus,
  {
    label: string;
    dotClass: string;
    iconClass: string;
    textClass: string;
    Icon: typeof CheckIcon;
  }
> = {
  cited: {
    label: "Cited",
    dotClass: "bg-positive",
    iconClass: "text-positive-foreground",
    textClass: "text-positive",
    Icon: CheckIcon,
  },
  lost: {
    label: "Lost",
    dotClass: "bg-negative",
    iconClass: "text-negative-foreground",
    textClass: "text-negative",
    Icon: XIcon,
  },
  missing: {
    label: "Not cited",
    dotClass: "bg-muted",
    iconClass: "text-surface",
    textClass: "text-muted",
    Icon: MinusIcon,
  },
};

export function EngineCitations({ data, className }: EngineCitationsProps) {
  return (
    <ul
      className={cn(
        "grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3",
        className
      )}
    >
      {data.map(({ engine, status, detail }) => {
        const spec = STATUS_SPEC[status];
        return (
          <li
            key={engine}
            className="flex items-center gap-3 rounded-md border bg-surface-raised px-3 py-2.5"
          >
            <span
              aria-hidden
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full",
                spec.dotClass
              )}
            >
              <spec.Icon className={cn("size-3.5", spec.iconClass)} strokeWidth={3} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{engine}</span>
              {detail ? (
                <span className="block truncate font-mono text-xs text-muted">{detail}</span>
              ) : null}
            </span>
            <span className={cn("font-mono text-xs", spec.textClass)}>{spec.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
