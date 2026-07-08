/**
 * Dual-palette emission (`dualModeTenantCss`) — the operator brand's
 * app-wide mode mechanism. Guards:
 * (a) the LIGHT palette is the unconditional base for the scope (boot),
 * (b) the DARK palette applies under the STANDARD mechanism — the
 *     `prefers-color-scheme: dark` media query (respecting a forced
 *     data-theme="light") AND the `data-theme="dark"` override,
 * (c) both blocks are the engine's gate-validated variable sets verbatim,
 * (d) `color-scheme` follows the palette polarity,
 * (e) scope ids are sanitized like the engine's `tenantThemeCss`.
 */

import { describe, expect, test } from "vitest";
import { resolveTenantTheme } from "./engine";
import { dualModeTenantCss } from "./operator-mode-css";
import { operatorModeTheme, OPERATOR_TENANT_ID } from "./operator-theme";

const light = resolveTenantTheme(operatorModeTheme.light);
const dark = resolveTenantTheme(operatorModeTheme.dark);
const css = dualModeTenantCss(light, dark, OPERATOR_TENANT_ID);

describe("dualModeTenantCss — operator light/dark emission", () => {
  test("light palette is the unconditional scope base (the app boots light)", () => {
    const base = css.match(
      /^:root\[data-tenant-theme="operator"\] \{\n([\s\S]*?)\n\}/
    );
    expect(base).not.toBeNull();
    expect(base![1]).toContain(`--surface: ${light.variables["--surface"]};`);
    expect(base![1]).toContain(`--accent: ${light.variables["--accent"]};`);
    expect(base![1]).toContain("color-scheme: light;");
    // The base block is the light palette, not the dark one.
    expect(base![1]).not.toContain(dark.variables["--surface"]);
  });

  test("dark palette applies via data-theme='dark' (the explicit override)", () => {
    const override = css.match(
      /:root\[data-tenant-theme="operator"\]\[data-theme="dark"\] \{\n([\s\S]*?)\n\}/
    );
    expect(override).not.toBeNull();
    expect(override![1]).toContain(`--surface: ${dark.variables["--surface"]};`);
    expect(override![1]).toContain(`--accent: ${dark.variables["--accent"]};`);
    expect(override![1]).toContain("color-scheme: dark;");
  });

  test("dark palette applies via the OS media query, EXCEPT when light is forced", () => {
    const media = css.match(
      /@media \(prefers-color-scheme: dark\) \{\n  (:root\[data-tenant-theme="operator"\]:not\(\[data-theme="light"\]\)) \{\n([\s\S]*?)\n  \}\n\}/
    );
    expect(media).not.toBeNull();
    // The :not() guard is what lets data-theme="light" force light under an
    // OS dark preference — the standard mechanism's override contract.
    expect(media![1]).toContain(':not([data-theme="light"])');
    expect(media![2]).toContain(`--surface: ${dark.variables["--surface"]};`);
  });

  test("both blocks carry the engine's full variable sets (gate output verbatim)", () => {
    for (const [name, value] of Object.entries(light.variables)) {
      expect(css).toContain(`${name}: ${value};`);
    }
    for (const [name, value] of Object.entries(dark.variables)) {
      expect(css).toContain(`${name}: ${value};`);
    }
  });

  test("derived on-color foregrounds are present in both palettes", () => {
    expect(light.variables["--accent-foreground"]).toBeDefined();
    expect(dark.variables["--accent-foreground"]).toBeDefined();
  });

  test("scope id is sanitized (quotes/backslashes stripped) like tenantThemeCss", () => {
    const hostile = dualModeTenantCss(light, dark, 'op"]\\{evil}');
    expect(hostile).toContain(':root[data-tenant-theme="op]{evil}"]');
    expect(hostile).not.toContain('op"]');
  });
});
