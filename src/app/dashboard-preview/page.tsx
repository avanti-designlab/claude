import type { Metadata } from "next";
import { TenantThemeScope } from "@/lib/theme";
import {
  blueDepthTheme,
  BLUE_DEPTH_SCOPE_ID,
  type BlueDepthVariant,
} from "@/lib/theme/operator-theme";
import { DashboardPreview } from "./dashboard";

export const metadata: Metadata = {
  title: "Design preview — sample dashboard",
  description:
    "A visual target for the operator dashboard, rendered in the operator brand with sample data. Not the live M19 module.",
};

/**
 * DESIGN PREVIEW route — pass 3 (operator direction, 2026-07-08). Two
 * variants of the blue-depth "illuminated" treatment for the operator to
 * choose between:
 *
 *   /dashboard-preview               → (a) refined LIGHT chrome
 *   /dashboard-preview?variant=dark  → (b) DARK glow chrome (the reference)
 *
 * Each variant is a full tenant-theme INPUT resolved through the FROZEN
 * theming engine's accessibility gate and applied with the sanctioned
 * `TenantThemeScope` wrapper — the engine, token contract, and Signal
 * defaults are untouched. All chrome is token-driven, so this page re-skins
 * per tenant like the app.
 */
export default async function DashboardPreviewPage({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string | string[] }>;
}) {
  const params = await searchParams;
  const variant: BlueDepthVariant = params.variant === "dark" ? "dark" : "light";
  return (
    <TenantThemeScope
      theme={blueDepthTheme[variant]}
      tenantId={BLUE_DEPTH_SCOPE_ID[variant]}
      className="min-h-dvh bg-surface"
    >
      <DashboardPreview variant={variant} />
    </TenantThemeScope>
  );
}
