"use client";

/**
 * Phase 1.1 onboarding flow (doc 06 §5). A client-side stepper — no backend,
 * no DB — that drives the real playbook engine in-browser:
 *
 *   select industry → add location(s) → connect properties →
 *   plan assembling (moment #1) → custom plan (real GeneratedRoadmap)
 *
 * The plan is generated from `generatePlan(getPlaybook(vertical), { now })`.
 * `now` is captured in the click handler (not at render) so the pure generator
 * stays replayable and nothing hydration-sensitive runs on the server.
 */

import * as React from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Entrance } from "@/components/moments";
import { GlowCard } from "@/components/dashboard-preview";
import { ACTIVE_VERTICALS, getPlaybook } from "@/lib/playbooks";
import { generatePlan } from "@/lib/plan";
import type { LocalIntensity, SeedVertical } from "@/lib/types/playbook";
import type { PropertyPlatform } from "@/lib/types/db";
import type { GeneratedRoadmap } from "@/lib/types/roadmap";
import { OnboardingStepper, type OnboardingStepMeta } from "./onboarding-stepper";
import { StepIndustry } from "./step-industry";
import { StepLocations, type LocationDraft } from "./step-locations";
import { StepProperties, type PropertyDraft } from "./step-properties";
import { StepAssembling } from "./step-assembling";
import { StepPlan } from "./step-plan";
import { SaveClientPanel } from "@/components/clients/save-client-panel";
import { VERTICAL_META } from "./onboarding-copy";

const STEPS: OnboardingStepMeta[] = [
  { id: 1, label: "Industry" },
  { id: 2, label: "Locations" },
  { id: 3, label: "Properties" },
  { id: 4, label: "Assembling" },
  { id: 5, label: "Your plan" },
];

let draftSeq = 0;
const nextDraftId = (prefix: string) => `${prefix}-${(draftSeq += 1)}`;

function isDormant(vertical: SeedVertical): boolean {
  return !ACTIVE_VERTICALS.includes(vertical);
}

// Falls back to "" (not "Your") — consumers compose their own headings and
// collapse a missing label instead of doubling the pronoun.
function verticalLabel(vertical: SeedVertical | null): string {
  return VERTICAL_META.find((entry) => entry.id === vertical)?.label ?? "";
}

/**
 * Mode-aware on-hero foregrounds (working brand v1): the hero bubble is a
 * vivid-blue fill in light mode (derived --accent-foreground) and a
 * navy-glow fill in dark mode (light ink/muted tokens). Pure token choices.
 */
const HERO = {
  base: "text-accent-foreground dark:text-ink",
  soft: "text-accent-foreground/85 dark:text-ink/85",
  dim: "text-accent-foreground/75 dark:text-muted",
};

export function OnboardingFlow() {
  const [step, setStep] = React.useState(1);
  const [vertical, setVertical] = React.useState<SeedVertical | null>(null);
  const [locations, setLocations] = React.useState<LocationDraft[]>([
    { id: "loc-0", value: "" },
  ]);
  const [properties, setProperties] = React.useState<PropertyDraft[]>([
    { id: "prop-0", url: "", platform: "" },
  ]);
  const [roadmap, setRoadmap] = React.useState<GeneratedRoadmap | null>(null);

  const localIntensity: LocalIntensity | null = React.useMemo(
    () => (vertical ? (getPlaybook(vertical)?.local_intensity ?? null) : null),
    [vertical]
  );

  const canAdvance = React.useMemo(() => {
    if (step === 1) return vertical !== null;
    if (step === 2) return locations.some((l) => l.value.trim().length > 0);
    if (step === 3) return properties.some((p) => p.url.trim().length > 0);
    return true;
  }, [step, vertical, locations, properties]);

  // Locations ----------------------------------------------------------
  const updateLocation = (id: string, value: string) =>
    setLocations((prev) =>
      prev.map((l) => (l.id === id ? { ...l, value } : l))
    );
  const addLocation = () =>
    setLocations((prev) => [...prev, { id: nextDraftId("loc"), value: "" }]);
  const removeLocation = (id: string) =>
    setLocations((prev) => prev.filter((l) => l.id !== id));

  // Properties ---------------------------------------------------------
  const updatePropertyUrl = (id: string, url: string) =>
    setProperties((prev) =>
      prev.map((p) => (p.id === id ? { ...p, url } : p))
    );
  const updatePropertyPlatform = (id: string, platform: PropertyPlatform) =>
    setProperties((prev) =>
      prev.map((p) => (p.id === id ? { ...p, platform } : p))
    );
  const addProperty = () =>
    setProperties((prev) => [
      ...prev,
      { id: nextDraftId("prop"), url: "", platform: "" },
    ]);
  const removeProperty = (id: string) =>
    setProperties((prev) => prev.filter((p) => p.id !== id));

  // Navigation ---------------------------------------------------------
  const goBack = () => setStep((s) => Math.max(1, s - 1));

  const goNext = () => {
    if (!canAdvance) return;
    // Leaving step 3 → generate the real plan. `now` captured here, not at
    // render, so the pure generator stays deterministic and hydration-safe.
    // Dormant verticals get no roadmap (Gate 1a: only active playbooks serve
    // client plans) — they fall through to the truthful coming-soon state.
    if (step === 3 && vertical) {
      const playbook = isDormant(vertical) ? null : getPlaybook(vertical);
      setRoadmap(
        playbook
          ? generatePlan({ playbook, now: new Date().toISOString() })
          : null
      );
    }
    setStep((s) => Math.min(STEPS.length, s + 1));
  };

  const restart = () => {
    setStep(1);
    setVertical(null);
    setLocations([{ id: "loc-0", value: "" }]);
    setProperties([{ id: "prop-0", url: "", platform: "" }]);
    setRoadmap(null);
  };

  // Step 1 asks its big question AT DISPLAY SCALE in the hero band (the step
  // panel's own heading goes visually hidden); later steps keep the greeting.
  const heroTitle =
    step === 1 ? "Which industry are we optimizing?" : "Let’s build your plan";

  return (
    <TooltipProvider>
      {/* HERO — the floating rounded bubble (working brand v1; converted from
          the pass-2 full-width band). The page's one glow moment; entrance
          step 0 with the bloom after the card lands. Text rides mode-aware
          token foregrounds, never a raw white assumption. */}
      <Entrance step={0} className="mx-auto w-full max-w-3xl px-4 pt-6 sm:px-6">
        <GlowCard surface="hero" scale="hero" bloom>
          <div className={"flex flex-col gap-2 p-7 sm:p-9 " + HERO.base}>
            <div className="flex items-center justify-between gap-4">
              <p className="font-display text-lg leading-6 font-bold">Signal</p>
              <span className={"font-mono text-xs " + HERO.dim}>
                Step {step} of {STEPS.length}
              </span>
            </div>
            <h1 className="font-display text-3xl leading-[1.05] font-bold tracking-[-0.02em] sm:text-display lg:text-hero">
              {heroTitle}
            </h1>
            <p className={"max-w-md " + HERO.soft}>
              A playbook-driven AEO/SEO/GEO and local plan — assembled from your
              industry, locations, and properties.
            </p>
          </div>
        </GlowCard>
      </Entrance>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-4 py-10 sm:px-6">
        <Entrance as="header" step={1} className="flex flex-col gap-6">
          <OnboardingStepper steps={STEPS} current={step} />
        </Entrance>

        {/* One entrance on the panel CONTAINER at load only — step changes
            swap children inside (no remount), so forms stay instant. */}
        <Entrance as="main" step={2} aria-live="polite">
          {step === 1 ? (
            <StepIndustry value={vertical} onChange={setVertical} />
          ) : null}

          {step === 2 ? (
            <StepLocations
              locations={locations}
              localIntensity={localIntensity}
              onUpdate={updateLocation}
              onAdd={addLocation}
              onRemove={removeLocation}
            />
          ) : null}

          {step === 3 ? (
            <StepProperties
              properties={properties}
              onUpdateUrl={updatePropertyUrl}
              onUpdatePlatform={updatePropertyPlatform}
              onAdd={addProperty}
              onRemove={removeProperty}
            />
          ) : null}

          {step === 4 ? (
            <StepAssembling
              roadmap={roadmap}
              isDormantVertical={vertical ? isDormant(vertical) : true}
              onContinue={() => setStep(5)}
            />
          ) : null}

          {step === 5 ? (
            <div className="flex flex-col gap-6">
              <StepPlan
                roadmap={roadmap}
                verticalLabel={verticalLabel(vertical)}
                isDormantVertical={vertical ? isDormant(vertical) : true}
              />
              {/* Persist the CLIENT record (the real write). Only offered for an
                  active vertical — dormant verticals serve no client yet
                  (Gate 1a). Plan/task persistence is the next slice. */}
              {vertical && !isDormant(vertical) ? (
                <SaveClientPanel
                  vertical={vertical}
                  verticalLabel={verticalLabel(vertical)}
                  locations={locations}
                  properties={properties}
                />
              ) : null}
            </div>
          ) : null}
        </Entrance>

        <Entrance
          as="footer"
          step={3}
          className="flex items-center justify-between gap-3 border-t pt-6"
        >
          <Button
            type="button"
            variant="ghost"
            onClick={goBack}
            disabled={step === 1}
          >
            <ArrowLeftIcon aria-hidden /> Back
          </Button>

          {step <= 3 ? (
            <Button type="button" onClick={goNext} disabled={!canAdvance}>
              Continue <ArrowRightIcon aria-hidden />
            </Button>
          ) : null}

          {step === 5 ? (
            <Button type="button" variant="outline" onClick={restart}>
              Start over
            </Button>
          ) : null}
        </Entrance>
      </div>
    </TooltipProvider>
  );
}
