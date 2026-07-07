"use client";

/**
 * Moment 5 of 5 (doc 06 §4.5) — the key state transition: plan → task →
 * published as a satisfying, legible state change. The pipeline is a real
 * sequence, so a numbered stepper is appropriate HERE (doc 06 §2) — and
 * nowhere decorative. Reduced motion snaps to the current state.
 */

import { CheckIcon } from "lucide-react";
import { motion } from "motion/react";
import { cn } from "@/lib/theme/utils";
import { useReducedMotion } from "./reduced-motion";

export interface StateTransitionProps {
  /** The ordered states, e.g. ["Plan", "Task", "Published"]. */
  states: string[];
  /** Index of the current state. */
  current: number;
  className?: string;
}

export function StateTransition({ states, current, className }: StateTransitionProps) {
  const reduced = useReducedMotion();
  const clamped = Math.min(states.length - 1, Math.max(0, current));

  return (
    <ol className={cn("flex items-center gap-2", className)}>
      {states.map((state, index) => {
        const done = index < clamped;
        const active = index === clamped;
        return (
          <li key={state} className="flex items-center gap-2">
            {index > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "h-px w-6 transition-colors duration-300 sm:w-10",
                  done || active ? "bg-accent" : "bg-border"
                )}
              />
            ) : null}
            <span
              className={cn(
                "relative flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm",
                active
                  ? "border-transparent text-accent-foreground"
                  : done
                    ? "border-transparent bg-overlay text-ink"
                    : "text-muted"
              )}
            >
              {active &&
                (reduced ? (
                  <span aria-hidden className="absolute inset-0 rounded-full bg-accent" />
                ) : (
                  <motion.span
                    aria-hidden
                    layoutId="state-transition-pill"
                    className="absolute inset-0 rounded-full bg-accent"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                ))}
              <span className="relative flex items-center gap-1.5">
                {done ? (
                  <CheckIcon aria-hidden className="size-3.5 text-positive" strokeWidth={3} />
                ) : (
                  <span className="font-mono text-xs">{index + 1}</span>
                )}
                {state}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
