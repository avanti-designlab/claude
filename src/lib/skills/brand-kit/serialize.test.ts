import { describe, expect, it } from "vitest";
import { buildBrandKit } from "./build";
import { SIGNAL_DEFAULT_TOKENS } from "./defaults";
import { lockKit } from "./lock";
import { toCssBlock, toCssVariables, toTenantTheme } from "./serialize";

describe("toCssVariables", () => {
  const vars = toCssVariables(SIGNAL_DEFAULT_TOKENS);

  it("emits exactly the doc 06 §2 color custom-property names", () => {
    expect(vars["--surface"]).toBe("#14181f");
    expect(vars["--surface-raised"]).toBe("#1c222b");
    expect(vars["--ink"]).toBe("#e9ecf1");
    expect(vars["--muted"]).toBe("#98a2b3");
    expect(vars["--accent"]).toBe("#e3a94f");
    expect(vars["--accent-secondary"]).toBe("#59c3dd");
    expect(vars["--accent-warm"]).toBe("#e9b872");
    expect(vars["--positive"]).toBe("#45c496");
    expect(vars["--negative"]).toBe("#ef7466");
    // The camelCase token name must NOT leak into CSS.
    expect(vars["--surfaceRaised"]).toBeUndefined();
    // No stray prefixed variants of the doc-mandated names.
    expect(vars["--color-surface"]).toBeUndefined();
  });

  it("emits font-face variables", () => {
    expect(vars["--font-display"]).toBe('"Space Grotesk", "Inter", system-ui, sans-serif');
    expect(vars["--font-body"]).toBe('"Inter", system-ui, -apple-system, sans-serif');
    expect(vars["--font-mono"]).toBe('"IBM Plex Mono", "SFMono-Regular", Menlo, monospace');
  });

  it("emits the type scale as --text-{step} with --line-height and optional --font-weight", () => {
    expect(vars["--text-base"]).toBe("0.9375rem");
    expect(vars["--text-base--line-height"]).toBe("1.5rem");
    expect(vars["--text-base--font-weight"]).toBeUndefined(); // no weight defined on base

    expect(vars["--text-score"]).toBe("5.25rem");
    expect(vars["--text-score--line-height"]).toBe("1");
    expect(vars["--text-score--font-weight"]).toBe("650");

    expect(vars["--text-2xl"]).toBe("1.75rem");
    expect(vars["--text-2xl--font-weight"]).toBe("600");
  });

  it("emits spacing as --space-unit plus --space-{multiplier} in px", () => {
    expect(vars["--space-unit"]).toBe("4px");
    expect(vars["--space-0"]).toBe("0px");
    expect(vars["--space-1"]).toBe("4px");
    expect(vars["--space-8"]).toBe("32px");
    expect(vars["--space-32"]).toBe("128px");
  });

  it("reflects a tenant palette, not hardcoded values", () => {
    const { kit } = buildBrandKit({ colors: { accent: "#45b0e6" } });
    const tenantVars = toCssVariables(kit.tokens);
    expect(tenantVars["--accent"]).toBe("#45b0e6");
  });
});

describe("toCssBlock", () => {
  it("renders a ready-to-inject :root rule", () => {
    const block = toCssBlock(SIGNAL_DEFAULT_TOKENS);
    expect(block.startsWith(":root {\n")).toBe(true);
    expect(block.endsWith("\n}")).toBe(true);
    expect(block).toContain("  --surface: #14181f;");
    expect(block).toContain("  --accent: #e3a94f;");
    expect(block).toContain("  --text-score--font-weight: 650;");
  });

  it("supports a custom selector for scoped tenant themes", () => {
    const block = toCssBlock(SIGNAL_DEFAULT_TOKENS, '[data-theme="tenant-2"]');
    expect(block.startsWith('[data-theme="tenant-2"] {\n')).toBe(true);
  });
});

describe("toTenantTheme", () => {
  it("projects a kit onto the exact tenants.theme jsonb shape (doc 03 §3)", () => {
    const { kit } = buildBrandKit({ colors: { accent: "#e3a94f" } });
    const theme = toTenantTheme(kit, {
      logoUrl: "https://cdn.example.com/agency/logo.svg",
      customDomain: "reports.agency.com",
    });

    expect(theme).toEqual({
      logo_url: "https://cdn.example.com/agency/logo.svg",
      colors: {
        surface: "#14181f",
        surface_raised: "#1c222b",
        ink: "#e9ecf1",
        muted: "#98a2b3",
        accent: "#e3a94f",
        accent_secondary: "#59c3dd",
        accent_warm: "#e9b872",
        positive: "#45c496",
        negative: "#ef7466",
      },
      font: {
        display: '"Space Grotesk", "Inter", system-ui, sans-serif',
        body: '"Inter", system-ui, -apple-system, sans-serif',
        mono: '"IBM Plex Mono", "SFMono-Regular", Menlo, monospace',
      },
      custom_domain: "reports.agency.com",
    });

    // Top-level keys are exactly the doc 03 shape — nothing extra.
    expect(Object.keys(theme).sort()).toEqual([
      "colors",
      "custom_domain",
      "font",
      "logo_url",
    ]);
    expect("surfaceRaised" in theme.colors).toBe(false);
  });

  it("defaults logo_url and custom_domain to null when not provided", () => {
    const { kit } = buildBrandKit({ colors: { accent: "#e3a94f" } });
    const theme = toTenantTheme(kit);
    expect(theme.logo_url).toBeNull();
    expect(theme.custom_domain).toBeNull();
  });

  it("serializes a locked (frozen) kit without touching it", () => {
    const locked = lockKit(buildBrandKit({ colors: { accent: "#45b0e6" } }).kit);
    const theme = toTenantTheme(locked, { logoUrl: "https://x.example/l.png" });
    expect(theme.colors.accent).toBe("#45b0e6");
    expect(locked.locked).toBe(true);
  });
});

describe("end-to-end: brand in → both consumers out", () => {
  it("build → lock → css variables + tenant theme from the same kit", () => {
    const { kit } = buildBrandKit({
      colors: { accent: "#7c5cff" },
      voice: { descriptors: ["confident"] },
    });
    const locked = lockKit(kit);

    const vars = toCssVariables(locked.tokens);
    const theme = toTenantTheme(locked, { customDomain: "app.tenant.io" });

    // One kit, two consumers, same values.
    expect(vars["--accent"]).toBe(theme.colors.accent);
    expect(vars["--surface"]).toBe(theme.colors.surface);
    expect(vars["--font-body"]).toBe(theme.font.body);
    expect(theme.custom_domain).toBe("app.tenant.io");
  });
});
