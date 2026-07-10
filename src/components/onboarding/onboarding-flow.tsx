"use client";

/**
 * Phase 1.1 onboarding flow (doc 06 §5). A client-side stepper that ends in
 * the real tenant write:
 *
 *   select industry → add location(s) → add the website (+ client name) →
 *   plan assembling (moment #1, covering the server write) →
 *   the SERVER-PERSISTED plan
 *
 * Leaving step 3 fires `createClientFromOnboarding` — the server action
 * persists the client AND generates + persists the plan/tasks server-side.
 * The assembling beat runs while that write is in flight and holds until it
 * resolves; steps 4–5 then render EXACTLY what the action returned
 * (`result.plan.roadmap`). The browser never runs the plan generator — a
 * single source of truth, no drift between what's shown and what's saved.
 */

import * as React from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Entrance } from "@/components/moments";
import { GlowCard } from "@/components/dashboard-preview";
import { getPlaybook } from "@/lib/playbooks";
import { createClientFromOnboarding } from "@/lib/clients/actions";
import { suggestClientName, toClientLocations } from "@/lib/clients/format";
import type { LocalIntensity, SeedVertical } from "@/lib/types/playbook";
import type { PropertyPlatform } from "@/lib/types/db";
import { OnboardingStepper, type OnboardingStepMeta } from "./onboarding-stepper";
import { StepIndustry } from "./step-industry";
import { StepLocations, type LocationDraft } from "./step-locations";
import { StepProperties, type PropertyDraft } from "./step-properties";
import { StepAssembling } from "./step-assembling";
import { StepPlan } from "./step-plan";
import { ClientNameField } from "./client-name-field";
import { SAVE_UNREACHABLE, toSaveState, type SaveState } from "./save-outcome";
import { VERTICAL_META } from "./onboarding-copy";
import {
  normalizeWebsiteUrl,
  websiteUrlProblem,
} from "@/components/properties/website-url";

const STEPS: OnboardingStepMeta[] = [
  { id: 1, label: "Industry" },
  { id: 2, label: "Locations" },
  { id: 3, label: "Website" },
  { id: 4, label: "Assembling" },
  { id: 5, label: "Your plan" },
];

let draftSeq = 0;
const nextDraftId = (prefix: string) => `${prefix}-${(draftSeq += 1)}`;

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
  // Client name: suggestion-tracking until the operator types (then theirs).
  const [nameEdited, setNameEdited] = React.useState<string | null>(null);
  const [save, setSave] = React.useState<SaveState>({ phase: "idle" });
  // ONE idempotency key per onboarding RUN (carried ticket a): minted when
  // the flow mounts, re-sent UNCHANGED by every retry — the key becomes the
  // client row id server-side, so a lost-response retry collides on the PK
  // and recovers the already-saved client instead of duplicating it. Only
  // "Start over" (a genuinely new client) mints a fresh key.
  const [runKey, setRunKey] = React.useState<string>(() =>
    crypto.randomUUID()
  );

  const localIntensity: LocalIntensity | null = React.useMemo(
    () => (vertical ? (getPlaybook(vertical)?.local_intensity ?? null) : null),
    [vertical]
  );

  const clientName =
    nameEdited ??
    suggestClientName(
      locations.map((l) => l.value),
      properties.map((p) => p.url)
    );

  const canAdvance = React.useMemo(() => {
    if (step === 1) return vertical !== null;
    if (step === 2) return locations.some((l) => l.value.trim().length > 0);
    if (step === 3) {
      // The FIRST property is the PRIMARY website — the single site the client
      // save persists (Orchestrator singular ruling). Because leaving step 3
      // promises "this website saves", the gate mirrors the server's
      // persistability check EXACTLY (remediation A1): the primary's URL —
      // after the same https:// normalization the payload gets — must pass
      // websiteUrlProblem (the sanitizePropertyUrl mirror), and a platform
      // must be picked (the frozen properties_website_has_platform CHECK
      // requires one). Nothing this gate passes can soft-fail server-side on
      // shape. Extra rows are added later from the workspace, not gated here.
      const primary = properties[0];
      const url = normalizeWebsiteUrl(primary.url);
      return (
        url !== "" &&
        websiteUrlProblem(url) === null &&
        primary.platform !== "" &&
        clientName.trim().length > 0
      );
    }
    return true;
  }, [step, vertical, locations, properties, clientName]);

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
    setProperties((prev) => {
      // FLOOR (remediation A7): never drop below one row, so `properties[0]`
      // (the primary) exists STRUCTURALLY — not by grace of render logic
      // (rows hide their remove button at one row, but state must not rely
      // on that).
      const next = prev.filter((p) => p.id !== id);
      return next.length > 0 ? next : prev;
    });

  // Save (the real write) ----------------------------------------------
  // Fired on leaving step 3, and again from step 4's retry after an error.
  // A reported error does NOT mean nothing was written — a lost response
  // leaves the save's fate unknown. The assembling beat covers the await;
  // steps 4–5 render the returned, persisted plan. Every attempt in this run
  // sends the SAME `runKey` — that is the whole point: if the failure was a
  // lost response, the retry replays into the same row, recovering the saved
  // client (and, after edits via Back, reconciling it to the edited values —
  // the action's update-through replay) instead of creating a second one.
  const startSave = () => {
    if (!vertical || save.phase === "saving") return;
    setSave({ phase: "saving" });
    // SINGULAR website (Orchestrator ruling): only the PRIMARY (first) property
    // persists. url + platform are sent per the landed contract; the action
    // resolves it softly and writes connection_method 'none' (never auth_ref).
    // Extra rows stay in the UI as workspace-seam adds and are intentionally
    // not sent. The payload URL is normalizeWebsiteUrl(primary.url) — the SAME
    // idempotent normalization the input applies on blur, so what the operator
    // sees in the field and what persists are byte-identical (remediation A1).
    // canAdvance already guarantees a persistable primary here; the guard keeps
    // the same-key step-4 retry safe if state ever differs.
    const primary = properties[0];
    const primaryUrl = normalizeWebsiteUrl(primary.url);
    const website =
      primaryUrl !== "" &&
      websiteUrlProblem(primaryUrl) === null &&
      primary.platform !== ""
        ? { url: primaryUrl, platform: primary.platform }
        : undefined;
    createClientFromOnboarding({
      name: clientName.trim(),
      vertical,
      locations: toClientLocations(locations.map((l) => l.value)),
      idempotencyKey: runKey,
      website,
    }).then(
      (result) => setSave(toSaveState(result)),
      () => setSave({ phase: "error", message: SAVE_UNREACHABLE })
    );
  };

  // Once the write is in flight or landed, the inputs are history — Back
  // would invite a duplicate client. Start over begins a fresh one; a
  // REPORTED failure reopens Back for edits — safe even if the save actually
  // landed, because the retry replays the same key and reconciles the row.
  const saveLocked =
    step >= 4 && (save.phase === "saving" || save.phase === "saved");

  // Navigation ---------------------------------------------------------
  const goBack = () => setStep((s) => Math.max(1, s - 1));

  const goNext = () => {
    if (!canAdvance) return;
    if (step === 3) startSave();
    setStep((s) => Math.min(STEPS.length, s + 1));
  };

  const restart = () => {
    setStep(1);
    setVertical(null);
    setLocations([{ id: "loc-0", value: "" }]);
    setProperties([{ id: "prop-0", url: "", platform: "" }]);
    setNameEdited(null);
    setSave({ phase: "idle" });
    // A fresh run is a fresh client — mint a NEW idempotency key so the next
    // save can never replay-recover the previous run's row.
    setRunKey(crypto.randomUUID());
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
            <div className="flex flex-col gap-6">
              <StepProperties
                properties={properties}
                onUpdateUrl={updatePropertyUrl}
                onUpdatePlatform={updatePropertyPlatform}
                onAdd={addProperty}
                onRemove={removeProperty}
              />
              {/* Continue out of this step is the real write, so the client's
                  name is confirmed here (pre-filled from the properties). */}
              <ClientNameField value={clientName} onChange={setNameEdited} />
            </div>
          ) : null}

          {step === 4 ? (
            <StepAssembling
              save={save}
              onRetry={startSave}
              onContinue={() => setStep(5)}
            />
          ) : null}

          {step === 5 && save.phase === "saved" ? (
            <StepPlan
              client={save.client}
              plan={save.plan}
              planWarning={save.planWarning}
              property={save.property}
              propertyWarning={save.propertyWarning}
              verticalLabel={verticalLabel(vertical)}
            />
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
            disabled={step === 1 || saveLocked}
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
