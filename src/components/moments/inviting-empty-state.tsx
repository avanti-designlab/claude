"use client";

/**
 * Moment 4 of 5 (doc 06 §4.4) — the inviting empty state: a first-action
 * moment, not mood decoration. One gentle entrance, then still. The copy
 * pattern follows doc 06 §6: name the next action, sentence case, plain
 * verbs. Reduced motion renders the state instantly.
 */

import * as React from "react";
import { motion } from "motion/react";
import type { LucideIcon } from "lucide-react";
import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/theme/utils";
import { useReducedMotion } from "./reduced-motion";

export interface InvitingEmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description: string;
  actionLabel: string;
  onAction?: () => void;
  className?: string;
}

export function InvitingEmptyState({
  icon: Icon = SparklesIcon,
  title,
  description,
  actionLabel,
  onAction,
  className,
}: InvitingEmptyStateProps) {
  const reduced = useReducedMotion();

  const body = (
    <>
      <span className="flex size-12 items-center justify-center rounded-full bg-overlay">
        <Icon aria-hidden className="size-5 text-accent" />
      </span>
      <div className="flex max-w-sm flex-col gap-1 text-center">
        <h3 className="text-lg font-semibold text-ink">{title}</h3>
        <p className="text-sm text-muted">{description}</p>
      </div>
      <Button onClick={onAction}>{actionLabel}</Button>
    </>
  );

  const frame = cn(
    "flex flex-col items-center gap-4 rounded-lg border border-dashed px-6 py-12",
    className
  );

  if (reduced) {
    return <div className={frame}>{body}</div>;
  }

  return (
    <motion.div
      className={frame}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 28 }}
    >
      {body}
    </motion.div>
  );
}
