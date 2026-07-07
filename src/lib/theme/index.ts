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

export { TenantThemeScope, type TenantThemeScopeProps } from "./scope";

export { DEMO_TENANTS, type DemoTenant } from "./demo-themes";

export { cn } from "./utils";
