/**
 * Dual-palette (light/dark) tenant-theme emission — the operator brand's
 * app-wide mode mechanism (operator direction, 2026-07-08).
 *
 * ADDITIVE module: it consumes the FROZEN engine's output
 * (`resolveTenantTheme` resolutions — gate-validated variable sets) and only
 * FORMATS them into mode-conditional CSS. The engine, token contract, and
 * Signal defaults are untouched; this is the same relationship `scope.tsx`
 * has to the engine.
 *
 * Emitted structure, for scope id `<id>`:
 *
 *   :root[data-tenant-theme="<id>"]                          → LIGHT palette
 *   :root[data-tenant-theme="<id>"][data-theme="dark"]       → DARK palette
 *   @media (prefers-color-scheme: dark)
 *     :root[data-tenant-theme="<id>"]:not([data-theme="light"]) → DARK palette
 *
 * i.e. the app BOOTS in the light palette, the dark palette applies under the
 * STANDARD mode mechanism — `prefers-color-scheme: dark` plus the existing
 * `data-theme` override used by the Signal defaults in globals.css
 * (`data-theme="light"` forces light, `data-theme="dark"` forces dark). The
 * dark rules carry one extra attribute selector, so they win over the light
 * base at higher specificity; the light base wins over the globals.css Signal
 * blocks by document order at equal specificity (injected <style> comes after
 * the stylesheet), exactly like the single-palette `tenantThemeCss` path.
 *
 * `color-scheme` is included per mode so UA chrome (form controls,
 * scrollbars, selection) follows the palette.
 */

import type { TenantThemeResolution } from "./engine";

/** Same scope-id sanitization as the engine's `tenantThemeCss`. */
function safeScopeId(tenantId: string): string {
  return tenantId.replace(/["\\]/g, "");
}

function declarationLines(
  variables: Record<string, string>,
  colorScheme: "light" | "dark",
  indent: string
): string {
  const lines = Object.entries(variables).map(
    ([name, value]) => `${indent}${name}: ${value};`
  );
  lines.push(`${indent}color-scheme: ${colorScheme};`);
  return lines.join("\n");
}

/**
 * Render two gate-validated resolutions (light + dark) as the ready-to-inject
 * dual-mode CSS described in the module comment. Callers must only pass
 * resolutions whose `source` is `"tenant"` — a fallback resolution means the
 * palette was refused, and the correct behavior is to not emit tenant CSS at
 * all (globals.css Signal defaults, which already carry both modes, apply).
 */
export function dualModeTenantCss(
  light: TenantThemeResolution,
  dark: TenantThemeResolution,
  tenantId: string
): string {
  const id = safeScopeId(tenantId);
  const lightBlock = declarationLines(light.variables, "light", "  ");
  const darkBlock = declarationLines(dark.variables, "dark", "  ");
  const darkBlockNested = declarationLines(dark.variables, "dark", "    ");
  return [
    `:root[data-tenant-theme="${id}"] {\n${lightBlock}\n}`,
    `:root[data-tenant-theme="${id}"][data-theme="dark"] {\n${darkBlock}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root[data-tenant-theme="${id}"]:not([data-theme="light"]) {\n${darkBlockNested}\n  }\n}`,
  ].join("\n");
}
