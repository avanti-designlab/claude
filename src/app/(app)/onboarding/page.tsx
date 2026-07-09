import type { Metadata } from "next";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";

export const metadata: Metadata = {
  title: "Onboarding — AEO/GEO + Brand Production OS",
  description:
    "Set up a client: pick the industry, add locations and properties, and reveal a real, playbook-driven AEO/GEO/local plan.",
};

/**
 * Phase 1.1 onboarding route — now inside the authenticated app shell
 * (src/app/(app)/layout.tsx gates it). The flow is client-side (React
 * stepper); leaving step 3 calls the tenant-scoped `createClientFromOnboarding`
 * server action, which persists the `clients` row AND generates + persists the
 * plan/tasks server-side — the plan the flow then shows is the action's
 * returned, persisted roadmap. See `@/components/onboarding/onboarding-flow`.
 */
export default function OnboardingPage() {
  return (
    <div className="flex-1">
      <OnboardingFlow />
    </div>
  );
}
