/**
 * F2 white-label theming engine — public surface.
 * Consumes the brand-kit pipeline (src/lib/skills/brand-kit) read-only.
 */

export {
  DERIVED_VARIABLE_NAMES,
  deriveOnColorForegrounds,
  resolveTenantTheme,
  SIGNAL_LIGHT_SURFACE,
  tenantThemeCss,
  type OnColorChoice,
  type ResolveTenantThemeOptions,
  type TenantThemeResolution,
} from "./engine";

export { dualModeTenantCss } from "./operator-mode-css";

export { TenantThemeScope, type TenantThemeScopeProps } from "./scope";

export { DEMO_TENANTS, type DemoTenant } from "./demo-themes";

export {
  operatorBuild,
  operatorModeBuild,
  operatorModeTheme,
  operatorTheme,
  OPERATOR_ACCENT_LIBRARY,
  OPERATOR_BRAND_INPUT,
  OPERATOR_DARK_SURFACE,
  OPERATOR_MODE_INPUTS,
  OPERATOR_TENANT_ID,
  OPERATOR_TYPOGRAPHY,
  type OperatorMode,
} from "./operator-theme";

export { cn } from "./utils";
