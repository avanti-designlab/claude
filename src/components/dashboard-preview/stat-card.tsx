/**
 * DESIGN PREVIEW — an insight/stat tile in the operator's Spendex craft: a
 * white card floating on the grey canvas, a THIN big number (the weight
 * contrast against the bold section headings is a brand signature), a black
 * circular ↗ button, and a green/red ▲▼ delta.
 *
 * The thin weight is set inline (deterministic) rather than via a scale step —
 * the frozen type scale's big steps carry a bold weight for headings; the data
 * numbers deliberately go the other way.
 */

import { cn } from "@/lib/theme/utils";
import { ArrowButton } from "./arrow-button";
import { Delta } from "./delta";

export interface StatCardProps {
  label: string;
  /** The big value, pre-formatted (e.g. "34%", "3,412", "#2"). */
  value: string;
  unit?: string;
  delta?: { value: number; unit?: string; context?: string };
  className?: string;
}

export function StatCard({ label, value, unit, delta, className }: StatCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-xl border bg-surface-raised p-5 shadow-sm",
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-mono text-[11px] tracking-[0.16em] text-muted uppercase">
          {label}
        </p>
        <ArrowButton label={`View ${label}`} size="sm" />
      </div>

      <div className="flex items-baseline gap-1.5">
        <span
          className="font-display text-display leading-none text-ink"
          style={{ fontWeight: 260 }}
        >
          {value}
        </span>
        {unit ? <span className="font-mono text-sm text-muted">{unit}</span> : null}
      </div>

      {delta ? (
        <Delta value={delta.value} unit={delta.unit} context={delta.context} />
      ) : null}
    </div>
  );
}
