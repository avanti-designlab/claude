"use client";

/**
 * Moment 3 of 5 (doc 06 §4.3) — tracker results settling: each query row
 * slides into place and its per-engine citation status pops in, one quick
 * pass after a tracker run. Reduced motion renders the settled table
 * instantly.
 */

import { motion } from "motion/react";
import { cn } from "@/lib/theme/utils";
import type { CitationStatus } from "@/components/charts/engine-citations";
import { useReducedMotion } from "./reduced-motion";

export interface TrackerResult {
  query: string;
  engine: string;
  status: CitationStatus;
  /** e.g. "#2 cited source" or "—". */
  position?: string;
}

export interface TrackerResultsSettleProps {
  results: TrackerResult[];
  className?: string;
}

const STATUS_DOT: Record<CitationStatus, string> = {
  cited: "bg-positive",
  lost: "bg-negative",
  missing: "bg-muted",
};

const STATUS_TEXT: Record<CitationStatus, { label: string; className: string }> = {
  cited: { label: "Cited", className: "text-positive" },
  lost: { label: "Lost", className: "text-negative" },
  missing: { label: "Not cited", className: "text-muted" },
};

function ResultRow({ result, reduced, index }: {
  result: TrackerResult;
  reduced: boolean;
  index: number;
}) {
  const status = STATUS_TEXT[result.status];
  const dot = (
    <span aria-hidden className={cn("size-2 rounded-full", STATUS_DOT[result.status])} />
  );
  return (
    <li className="flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0">
      {reduced ? (
        dot
      ) : (
        <motion.span
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{
            type: "spring",
            stiffness: 500,
            damping: 26,
            delay: 0.15 + index * 0.06,
          }}
          className="inline-flex"
        >
          {dot}
        </motion.span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-ink">{result.query}</span>
      <span className="hidden font-mono text-xs text-muted sm:inline">{result.engine}</span>
      <span className="hidden font-mono text-xs text-muted md:inline">
        {result.position ?? "—"}
      </span>
      <span className={cn("w-16 text-right font-mono text-xs", status.className)}>
        {status.label}
      </span>
    </li>
  );
}

export function TrackerResultsSettle({ results, className }: TrackerResultsSettleProps) {
  const reduced = useReducedMotion();

  const list = (
    <ul className="rounded-md border bg-surface-raised">
      {results.map((result, index) => (
        <ResultRow
          key={`${result.query}-${result.engine}`}
          result={result}
          reduced={reduced}
          index={index}
        />
      ))}
    </ul>
  );

  if (reduced) return <div className={className}>{list}</div>;

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
    >
      {list}
    </motion.div>
  );
}
