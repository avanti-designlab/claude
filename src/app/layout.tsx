import type { Metadata } from "next";
import "./globals.css";
import { resolveTenantTheme } from "@/lib/theme/engine";
import { dualModeTenantCss } from "@/lib/theme/operator-mode-css";
import { operatorModeTheme, OPERATOR_TENANT_ID } from "@/lib/theme/operator-theme";

export const metadata: Metadata = {
  title: "AEO/GEO + Brand Production OS",
  description:
    "AI-native agency operating system — AEO/GEO intelligence with brand-consistent production.",
};

/**
 * Tenant #1 (our agency) is the app's active brand — DUAL-PALETTE since the
 * pass-3 consolidation (operator direction, 2026-07-08): the app boots in the
 * blue-depth LIGHT palette, and the DARK-GLOW palette applies under the
 * standard mode mechanism (`prefers-color-scheme: dark` + the `data-theme`
 * override) — see `dualModeTenantCss`. Both palettes resolve through the SAME
 * frozen white-label path every reseller tenant uses (accessibility gate
 * included); nothing brand-shaped is hardcoded in components. If either
 * palette were ever refused, no tenant CSS is emitted and the app falls back
 * to the frozen Signal defaults in globals.css (which already carry both
 * modes) — a refused theme is never silently approximated.
 *
 * Computed once at module scope (the pipeline is pure — no network/DB) and
 * server-rendered, so there is no theme flash. The `<style>` is emitted after
 * the globals.css `<link>` in document order, so its light base wins over the
 * Signal blocks at equal specificity, and its dark rules carry one extra
 * attribute selector so they win over the light base under the media query /
 * `data-theme="dark"`.
 */
const operatorLight = resolveTenantTheme(operatorModeTheme.light);
const operatorDark = resolveTenantTheme(operatorModeTheme.dark);
const operatorApplied =
  operatorLight.source === "tenant" && operatorDark.source === "tenant";
const operatorScopeId = operatorApplied ? OPERATOR_TENANT_ID : "signal-fallback";
const operatorThemeCss = operatorApplied
  ? dualModeTenantCss(operatorLight, operatorDark, OPERATOR_TENANT_ID)
  : "";

/**
 * Root layout. Deliberately minimal: all chrome (colors, faces, type scale)
 * comes from the design tokens in globals.css, and tenant themes override
 * those same custom properties at runtime — nothing brand-shaped lives here.
 * `suppressHydrationWarning` covers the client-set `data-theme` /
 * `data-tenant-theme` attributes on <html> (the /design-system switcher and
 * the /dashboard-preview mode toggle).
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
