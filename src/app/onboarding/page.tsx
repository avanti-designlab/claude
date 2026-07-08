import type { Metadata } from "next";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";

export const metadata: Metadata = {
  title: "Onboarding — AEO/GEO + Brand Production OS",
  description:
    "Set up a client: pick the industry, add locations and properties, and reveal a real, playbook-driven AEO/GEO/local plan.",
};

/**
 * Phase 1.1 onboarding route. The flow is fully client-side (React stepper)
 * and runs the pure playbook engine in-browser — no backend needed. See
 * `@/components/onboarding/onboarding-flow`.
 */
export default function OnboardingPage() {
  return (
    <div className="flex-1">
      <OnboardingFlow />
    </div>
  );
}
