import type { Metadata } from "next";
import "./globals.css";
import { resolveTenantTheme, tenantThemeCss } from "@/lib/theme/engine";
import { operatorTheme, OPERATOR_TENANT_ID } from "@/lib/theme/operator-theme";

export const metadata: Metadata = {
  title: "AEO/GEO + Brand Production OS",
  description:
    "AI-native agency operating system — AEO/GEO intelligence with brand-consistent production.",
};

/**
 * Tenant #1 (our agency) is the app's active brand. It boots through the SAME
 * white-label path every reseller tenant uses: resolve the theme through the
 * accessibility gate, then apply the emitted variables on
 * `:root[data-tenant-theme="operator"]`. Nothing brand-shaped is hardcoded in
 * components — this is purely the theme layer overriding the frozen Signal
 * defaults in globals.css (the neutral fallback stays intact underneath).
 *
 * Computed once at module scope (the pipeline is pure — no network/DB) and
 * server-rendered, so there is no theme flash. The `<style>` is emitted after
 * the globals.css `<link>` in document order, so its equal-specificity
 * `:root[data-tenant-theme]` declarations win over the Signal light/dark
 * blocks (see `tenantThemeCss` in src/lib/theme/engine.ts).
 */
const operatorResolution = resolveTenantTheme(operatorTheme);
const operatorScopeId =
  operatorResolution.source === "tenant" ? OPERATOR_TENANT_ID : "signal-fallback";
const operatorThemeCss = tenantThemeCss(operatorResolution, OPERATOR_TENANT_ID);

/**
 * Root layout. Deliberately minimal: all chrome (colors, faces, type scale)
 * comes from the design tokens in globals.css, and tenant themes override
 * those same custom properties at runtime — nothing brand-shaped lives here.
 * `suppressHydrationWarning` covers the client-set `data-theme` /
 * `data-tenant-theme` attributes on <html> (the /design-system switcher).
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="h-full"
      data-tenant-theme={operatorScopeId}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col font-body">
        <style data-tenant-theme-boot={operatorScopeId}>{operatorThemeCss}</style>
        {children}
      </body>
    </html>
  );
}
