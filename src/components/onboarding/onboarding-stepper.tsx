"use client";

/**
 * Onboarding progress stepper. Sequential numbering is on-spec here (doc 06
 * §2: steppers belong to real sequences). Quiet by design — no animated
 * flourish; the one motion moment in this flow is the plan reveal.
 */

import { CheckIcon } from "lucide-react";
import { cn } from "@/lib/theme/utils";

export interface OnboardingStepMeta {
  id: number;
  label: string;
}

export interface OnboardingStepperProps {
  steps: OnboardingStepMeta[];
  /** 1-based current step. */
  current: number;
}

export function OnboardingStepper({ steps, current }: OnboardingStepperProps) {
  return (
    <ol className="flex items-center gap-2" aria-label="Onboarding progress">
      {steps.map((step, index) => {
        const isDone = step.id < current;
        const isActive = step.id === current;
        const isLast = index === steps.length - 1;

        return (
          <li key={step.id} className="flex flex-1 items-center gap-2">
            <div className="flex items-center gap-2">
              <span
                aria-current={isActive ? "step" : undefined}
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border font-mono text-xs transition-colors",
                  isDone && "border-accent bg-accent text-accent-foreground",
                  isActive && "border-accent text-ink",
                  !isDone && !isActive && "border-border text-muted"
                )}
              >
                {isDone ? (
                  <CheckIcon aria-hidden className="size-3.5" />
                ) : (
                  String(step.id).padStart(2, "0")
                )}
              </span>
              <span
                className={cn(
                  "hidden text-sm whitespace-nowrap sm:inline",
                  isActive ? "font-medium text-ink" : "text-muted"
                )}
              >
                {step.label}
              </span>
            </div>
            {!isLast ? (
              <span
                aria-hidden
                className={cn(
                  "h-px flex-1",
                  isDone ? "bg-accent" : "bg-border"
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
