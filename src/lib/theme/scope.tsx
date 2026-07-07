import * as React from "react";
import type { TenantTheme } from "@/lib/skills/brand-kit";
import {
  resolveTenantTheme,
  type ResolveTenantThemeOptions,
  type TenantThemeResolution,
} from "./engine";

export interface TenantThemeScopeProps {
  /** The tenant's stored theme (`tenants.theme` jsonb shape). */
  theme: TenantTheme;
  /** Stable identifier for the scope (tenant id / slug). */
  tenantId: string;
  children: React.ReactNode;
  className?: string;
  /** Forwarded to the engine (fallback logging). */
  options?: ResolveTenantThemeOptions;
  /** Receives the resolution so callers can surface the report/fallback. */
  onResolved?: (resolution: TenantThemeResolution) => void;
}

/**
 * Wrapper-scoped tenant theming: resolves the theme through the engine
 * (accessibility gate included) and applies the emitted variables as inline
 * custom properties, re-skinning every token-driven utility underneath —
 * zero component changes.
 *
 * NOTE: overlays that PORTAL to <body> (dialogs, dropdowns, toasts) escape a
 * wrapper scope. For whole-app white-labeling — the real product path — use
 * `tenantThemeCss()` on `:root[data-tenant-theme]` instead (that is what
 * /design-system does), and reserve this wrapper for embedded previews.
 */
export function TenantThemeScope({
  theme,
  tenantId,
  children,
  className,
  options,
  onResolved,
}: TenantThemeScopeProps) {
  const resolution = resolveTenantTheme(theme, options);
  onResolved?.(resolution);
  return (
    <div
      data-tenant-theme={resolution.source === "tenant" ? tenantId : "signal-fallback"}
      className={className}
      style={resolution.variables as React.CSSProperties}
    >
      {children}
    </div>
  );
}
