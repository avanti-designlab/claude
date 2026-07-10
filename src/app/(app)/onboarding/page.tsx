import type { Metadata } from "next";
import { guardOperatorSurface } from "@/components/app-shell/access";
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
 *
 * Onboarding is an OPERATOR surface: it sits outside the (operator) route group
 * (so it isn't covered by that group's layout guard), so it confines a
 * client_viewer here itself — the same `guardOperatorSurface()` every other
 * operator surface uses. RLS still backs the createClient action below.
 */
export default async function OnboardingPage() {
  await guardOperatorSurface();
  return (
    <div className="flex-1">
      <OnboardingFlow />
    </div>
  );
}
