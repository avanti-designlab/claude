"use client";

/**
 * The five animated moments (doc 06 §4) — the ONLY high-impact motion in the
 * product. Each demo has a replay control; flip the reduced-motion toggle in
 * the header to verify every moment renders its final state instantly.
 */

import * as React from "react";
import { FileTextIcon, RefreshCwIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  InvitingEmptyState,
  OnboardingPlanReveal,
  StateTransition,
  TrackerResultsSettle,
  VisibilityScoreResolve,
} from "@/components/moments";
import { Section } from "./section";

const PLAN_TASKS = [
  { title: "Add FAQPage schema to neighborhood guides", channel: "AEO", meta: "high impact" },
  { title: "Publish Q3 market report pillar page", channel: "Content", meta: "high impact" },
  { title: "Add Person schema + sameAs for all agents", channel: "AEO", meta: "medium" },
  { title: "Claim and dedupe GBP locations", channel: "Local", meta: "medium" },
  { title: "Fix render-blocking hero on /listings", channel: "Tech", meta: "quick win" },
];

const SCORE_ENGINES = [
  { engine: "GPT", status: "cited" as const },
  { engine: "CLD", status: "cited" as const },
  { engine: "PPX", status: "cited" as const },
  { engine: "AIO", status: "lost" as const },
  { engine: "GEM", status: "missing" as const },
  { engine: "COP", status: "missing" as const },
];

const TRACKER_RESULTS = [
  { query: "best realtor in san diego", engine: "ChatGPT", status: "cited" as const, position: "#2 source" },
  { query: "north park homes for sale", engine: "Perplexity", status: "cited" as const, position: "#1 source" },
  { query: "san diego housing market 2026", engine: "Claude", status: "cited" as const, position: "#3 source" },
  { query: "downtown condos for sale", engine: "AI Overviews", status: "lost" as const, position: "—" },
  { query: "sell my house fast san diego", engine: "Gemini", status: "missing" as const, position: "—" },
];

const PIPELINE_STATES = ["Plan", "Task", "Published"];

function MomentPanel({
  label,
  onReplay,
  replayLabel = "Replay",
  children,
}: {
  label: string;
  onReplay?: () => void;
  replayLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-mono text-xs text-muted">{label}</p>
        {onReplay ? (
          <Button size="sm" variant="ghost" onClick={onReplay}>
            <RefreshCwIcon aria-hidden /> {replayLabel}
          </Button>
        ) : null}
      </div>
      <div className="rounded-lg border bg-surface p-5">{children}</div>
    </div>
  );
}

export function MomentsGallery() {
  const [revealKey, setRevealKey] = React.useState(0);
  const [scoreKey, setScoreKey] = React.useState(0);
  const [trackerKey, setTrackerKey] = React.useState(0);
  const [pipelineState, setPipelineState] = React.useState(0);

  return (
    <Section
      id="moments"
      overline="05 · The five moments"
      title="Motion, exactly where it earns it"
      description="Five defined moments; everything else stays still. Every moment respects reduced motion — toggle it in the header and replay: the final state appears instantly."
    >
      <div className="flex flex-col gap-6">
        <MomentPanel
          label="2 · Visibility Score resolve — THE signature. Signal resolves out of noise; dots settle; the box never shifts."
          onReplay={() => setScoreKey((key) => key + 1)}
        >
          <VisibilityScoreResolve
            key={scoreKey}
            score={68}
            engines={SCORE_ENGINES}
            caption="+7 since the last tracker run · 4 of 6 engines citing"
          />
        </MomentPanel>

        <div className="grid gap-6 lg:grid-cols-2">
          <MomentPanel
            label="1 · Onboarding plan reveal — the plan assembles once, then holds still."
            onReplay={() => setRevealKey((key) => key + 1)}
          >
            <OnboardingPlanReveal key={revealKey} tasks={PLAN_TASKS} />
          </MomentPanel>

          <MomentPanel
            label="3 · Tracker results settle — rows land, statuses pop, done."
            onReplay={() => setTrackerKey((key) => key + 1)}
          >
            <TrackerResultsSettle key={trackerKey} results={TRACKER_RESULTS} />
          </MomentPanel>

          <MomentPanel label="4 · Inviting empty state — a first action, not decoration.">
            <InvitingEmptyState
              icon={FileTextIcon}
              title="No content in the pipeline yet"
              description="Your playbook plan has five content tasks ready to start."
              actionLabel="Generate first draft"
              onAction={() => toast("Draft queued", { description: "It will wait for your review — nothing publishes itself." })}
            />
          </MomentPanel>

          <MomentPanel
            label="5 · Key state transition — plan → task → published, a satisfying change."
            onReplay={() =>
              setPipelineState((state) => (state + 1) % PIPELINE_STATES.length)
            }
            replayLabel="Advance"
          >
            <div className="flex min-h-24 items-center justify-center">
              <StateTransition states={PIPELINE_STATES} current={pipelineState} />
            </div>
          </MomentPanel>
        </div>
      </div>
    </Section>
  );
}
