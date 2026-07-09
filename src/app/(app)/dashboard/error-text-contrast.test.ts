/**
 * Contrast proof for the inline error-text treatment (design review, 2026-07-09,
 * Major 4): plain `text-negative` at normal-text sizes (11px in the
 * Generate-plan row, 13px in the login form) is only 3:1-gated by the F2
 * palette policy — the Signal-fallback LIGHT palette measures ~3.6:1 on the
 * card surface, failing WCAG 1.4.3 AA (4.5:1) for body-size text.
 *
 * The designer-directed tactical fix is a light-mode ink-mix, dark mode
 * unchanged. Their example share (75%) measures 4.46:1 on the Signal-fallback
 * light CARD (#e7ebf2) — still short — so the shipped value is the nearest
 * round share that clears every combo with quantization headroom
 * (the designer signs off on the concrete value):
 *
 *   text-[color-mix(in_oklab,var(--negative)_70%,var(--ink))] dark:text-negative
 *
 * This suite recomputes that CSS `color-mix(in oklab, …)` from the CSS Color 4
 * math and asserts >= 4.5:1 against BOTH chrome layers (`surface` and
 * `surfaceRaised` — the F2 pair-set policy; the error text renders on cards,
 * i.e. surfaceRaised) for BOTH palettes that can reach these screens:
 *
 *   - the operator boot theme (light + dark modes, post-gate kit values), and
 *   - the frozen "Signal" framework fallback (light + dark token blocks).
 *
 * Used by: src/app/(app)/dashboard/generate-plan-row.tsx and
 * src/components/auth/login-form.tsx (the identical-pattern sweep).
 */

import { describe, expect, test } from "vitest";
import {
  contrastRatio,
  hexToRgb,
  rgbToHex,
  SIGNAL_COLORS,
  buildBrandKit,
} from "@/lib/skills/brand-kit";
import { SIGNAL_LIGHT_SURFACE } from "@/lib/theme/light-surface";
import { operatorModeBuild } from "@/lib/theme/operator-theme";

/** The mix the utility class encodes: negative 70%, ink 30%, in oklab. */
const NEGATIVE_SHARE = 0.7;

/* ----------------------------------------------------------------------
 * CSS Color 4 `color-mix(in oklab, A p%, B)` for two OPAQUE sRGB colors:
 * sRGB → linear sRGB → LMS → cube root → OKLab, linear interpolation per
 * component, then the inverse path. Matrices from the OKLab reference
 * (Björn Ottosson), as normatively cited by CSS Color 4 §12.2.
 * -------------------------------------------------------------------- */

type Triple = [number, number, number];

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function hexToOklab(hex: string): Triple {
  const { r, g, b } = hexToRgb(hex);
  const [lr, lg, lb] = [r / 255, g / 255, b / 255].map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToHex(lab: Triple): string {
  const [L, a, b] = lab;
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  const linear: Triple = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const channels = linear.map((c) => {
    const v = linearToSrgb(c);
    // Both endpoints are in-gamut sRGB; assert the mix stayed in gamut (tiny
    // float excursions only), then clamp for 8-bit quantization.
    expect(v).toBeGreaterThan(-0.001);
    expect(v).toBeLessThan(1.001);
    return Math.min(1, Math.max(0, v)) * 255;
  });
  return rgbToHex({ r: channels[0], g: channels[1], b: channels[2] });
}

/** `color-mix(in oklab, a share, b)` — returns the painted #rrggbb. */
function mixOklab(a: string, b: string, share: number): string {
  const la = hexToOklab(a);
  const lb = hexToOklab(b);
  return oklabToHex([
    la[0] * share + lb[0] * (1 - share),
    la[1] * share + lb[1] * (1 - share),
    la[2] * share + lb[2] * (1 - share),
  ]);
}

/* ----------------------------------------------------------------------
 * The four palette/mode combos + what the class resolves to in each.
 * -------------------------------------------------------------------- */

interface Combo {
  name: string;
  /** What the class paints in this mode: the mix (light) or --negative (dark). */
  resolved: string;
  surfaces: { surface: string; surfaceRaised: string };
  negative: string;
}

/** The light-adapted Signal palette, recomputed through the pipeline (same
 *  derivation the globals-parity test pins to globals.css). */
const signalLight = buildBrandKit({
  colors: {
    accent: SIGNAL_COLORS.accent,
    surface: SIGNAL_LIGHT_SURFACE,
    positive: SIGNAL_COLORS.positive,
    negative: SIGNAL_COLORS.negative,
  },
}).kit.tokens.colors;

const operatorLight = operatorModeBuild.light.kit.tokens.colors;
const operatorDark = operatorModeBuild.dark.kit.tokens.colors;

const COMBOS: Combo[] = [
  {
    name: "operator light (boot theme)",
    resolved: mixOklab(operatorLight.negative, operatorLight.ink, NEGATIVE_SHARE),
    surfaces: {
      surface: operatorLight.surface,
      surfaceRaised: operatorLight.surfaceRaised,
    },
    negative: operatorLight.negative,
  },
  {
    name: "operator dark (boot theme)",
    resolved: operatorDark.negative, // dark:text-negative — no mix
    surfaces: {
      surface: operatorDark.surface,
      surfaceRaised: operatorDark.surfaceRaised,
    },
    negative: operatorDark.negative,
  },
  {
    name: "Signal fallback light",
    resolved: mixOklab(signalLight.negative, signalLight.ink, NEGATIVE_SHARE),
    surfaces: {
      surface: signalLight.surface,
      surfaceRaised: signalLight.surfaceRaised,
    },
    negative: signalLight.negative,
  },
  {
    name: "Signal fallback dark",
    resolved: SIGNAL_COLORS.negative, // dark:text-negative — no mix
    surfaces: {
      surface: SIGNAL_COLORS.surface,
      surfaceRaised: SIGNAL_COLORS.surfaceRaised,
    },
    negative: SIGNAL_COLORS.negative,
  },
];

describe("inline error text — 4.5:1 on every chrome layer, every mode (design review Major 4)", () => {
  const round = (n: number) => Math.round(n * 100) / 100;

  for (const combo of COMBOS) {
    test(`${combo.name}: resolved error color clears WCAG AA normal text on both surfaces`, () => {
      const onSurface = contrastRatio(combo.resolved, combo.surfaces.surface);
      const onRaised = contrastRatio(combo.resolved, combo.surfaces.surfaceRaised);
      // Reported for the review record (the finding requires the numbers).
      console.log(
        `${combo.name}: ${combo.resolved} → ${round(onSurface)}:1 on surface ` +
          `${combo.surfaces.surface}, ${round(onRaised)}:1 on card ${combo.surfaces.surfaceRaised} ` +
          `(plain --negative ${combo.negative}: ${round(
            contrastRatio(combo.negative, combo.surfaces.surface)
          )}:1 / ${round(contrastRatio(combo.negative, combo.surfaces.surfaceRaised))}:1)`
      );
      expect(onSurface).toBeGreaterThanOrEqual(4.5);
      expect(onRaised).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("the light-mode mix exists for a reason: plain --negative fails AA on the Signal fallback light card", () => {
    // The regression the fix answers (measured 3.61:1 in review). If the
    // palette itself is ever re-tuned to clear 4.5:1, this pin — and possibly
    // the mix — can be revisited with the designer.
    const plain = contrastRatio(signalLight.negative, signalLight.surfaceRaised);
    expect(plain).toBeLessThan(4.5);
  });
});
