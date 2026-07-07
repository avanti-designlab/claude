"use client";

/**
 * Moment 1 of 5 (doc 06 §4.1) — the onboarding "your custom plan is
 * assembling" reveal: playbook + audit becomes a prioritized roadmap, staged
 * in one pass. Reduced motion renders the complete plan instantly.
 */

import { motion } from "motion/react";
import { cn } from "@/lib/theme/utils";
import { useReducedMotion } from "./reduced-motion";

export interface PlanRevealTask {
  title: string;
  /** Channel / module the task belongs to, e.g. "AEO", "Local", "Content". */
  channel: string;
  /** Effort weight shown as quiet metadata, e.g. "high impact". */
  meta?: string;
}

export interface OnboardingPlanRevealProps {
  heading?: string;
  subheading?: string;
  tasks: PlanRevealTask[];
  className?: string;
}

const container = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.09, delayChildren: 0.25 } },
};

const item = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: "spring" as const, stiffness: 380, damping: 30 },
  },
};

function TaskRow({ task, index }: { task: PlanRevealTask; index: number }) {
  return (
    <div className="flex items-center gap-3 rounded-md border bg-surface-raised px-4 py-3">
      <span className="font-mono text-xs text-muted">
        {String(index + 1).padStart(2, "0")}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
        {task.title}
      </span>
      {task.meta ? (
        <span className="hidden font-mono text-xs text-muted sm:inline">{task.meta}</span>
      ) : null}
      <span className="rounded-sm bg-overlay px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-muted uppercase">
        {task.channel}
      </span>
    </div>
  );
}

export function OnboardingPlanReveal({
  heading = "Your plan is ready",
  subheading = "Assembled from the industry playbook and your site audit.",
  tasks,
  className,
}: OnboardingPlanRevealProps) {
  const reduced = useReducedMotion();

  const header = (
    <header className="flex flex-col gap-1">
      <h3 className="font-display text-2xl text-ink">{heading}</h3>
      <p className="text-sm text-muted">{subheading}</p>
    </header>
  );

  if (reduced) {
    return (
      <div className={cn("flex flex-col gap-4", className)}>
        {header}
        <div className="flex flex-col gap-2">
          {tasks.map((task, index) => (
            <TaskRow key={task.title} task={task} index={index} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        {header}
      </motion.div>
      <motion.div
        className="flex flex-col gap-2"
        variants={container}
        initial="hidden"
        animate="visible"
      >
        {tasks.map((task, index) => (
          <motion.div key={task.title} variants={item}>
            <TaskRow task={task} index={index} />
          </motion.div>
        ))}
      </motion.div>
    </div>
  );
}
