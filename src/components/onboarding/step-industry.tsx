"use client";

/**
 * Step 1 — select industry (doc 06 §5).
 *
 * Real estate is the one active vertical for the Gate 1a validation pass
 * (ACTIVE_VERTICALS, doc 02). The other four are visible and selectable but
 * clearly marked dormant — validation-first rollout, honestly surfaced.
 */

import { CheckIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ACTIVE_VERTICALS } from "@/lib/playbooks";
import type { SeedVertical } from "@/lib/types/playbook";
import { cn } from "@/lib/theme/utils";
import { VERTICAL_META } from "./onboarding-copy";

export interface StepIndustryProps {
  value: SeedVertical | null;
  onChange: (vertical: SeedVertical) => void;
}

function isActive(vertical: SeedVertical): boolean {
  return ACTIVE_VERTICALS.includes(vertical);
}

export function StepIndustry({ value, onChange }: StepIndustryProps) {
  const dormantSelected = value !== null && !isActive(value);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1.5">
        <h2 className="font-display text-2xl text-ink">
          Which industry are we optimizing?
        </h2>
        <p className="text-sm text-muted">
          Your industry playbook drives everything that follows — the prompts we
          track, the schema we write, and how hard the local push runs.
        </p>
      </header>

      <div
        role="radiogroup"
        aria-label="Industry"
        className="grid gap-3 sm:grid-cols-2"
      >
        {VERTICAL_META.map((vertical) => {
          const Icon = vertical.icon;
          const active = isActive(vertical.id);
          const selected = value === vertical.id;

          return (
            <button
              key={vertical.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(vertical.id)}
              className={cn(
                "group relative flex flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-colors outline-none",
                "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
                selected
                  ? "border-accent ring-1 ring-accent"
                  : "hover:border-ink/25",
                !active && !selected && "opacity-75"
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <span
                  className={cn(
                    "flex size-9 items-center justify-center rounded-lg",
                    selected ? "bg-accent/15" : "bg-overlay"
                  )}
                >
                  <Icon
                    aria-hidden
                    className={cn(
                      "size-5",
                      selected ? "text-accent" : "text-muted"
                    )}
                  />
                </span>
                {active ? (
                  <Badge variant="secondary" className="gap-1">
                    <span className="size-1.5 rounded-full bg-positive" />
                    Live now
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted">
                    Coming soon
                  </Badge>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 font-medium text-ink">
                  {vertical.label}
                  {selected ? (
                    <CheckIcon aria-hidden className="size-4 text-accent" />
                  ) : null}
                </span>
                <span className="text-sm text-muted">{vertical.blurb}</span>
              </div>
            </button>
          );
        })}
      </div>

      {dormantSelected ? (
        <p
          role="status"
          className="rounded-lg border border-dashed bg-surface-raised px-4 py-3 text-sm text-muted"
        >
          We&apos;re rolling out one industry at a time — real estate is live
          first. You can preview the full flow for this industry now; its plan
          arrives once the playbook is switched on.
        </p>
      ) : null}
    </div>
  );
}
