/**
 * Freeze-criterion 1 enforcement (doc 06 §8): the token values in
 * src/app/globals.css are the OUTPUT of the brand-kit pipeline, not
 * hand-tuned CSS. This test recomputes both palettes through the library and
 * fails on any drift between the stylesheet and the pipeline.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  buildBrandKit,
  SIGNAL_COLORS,
  SIGNAL_DEFAULT_TOKENS,
  toCssVariables,
} from "@/lib/skills/brand-kit";
import { deriveOnColorForegrounds, SIGNAL_LIGHT_SURFACE } from "./engine";

const globalsCss = readFileSync(
  new URL("../../app/globals.css", import.meta.url),
  "utf8"
);

/** Extract the CSS text between two marker comments. */
function markedBlock(name: string): string {
  const pattern = new RegExp(
    `/\\* @${name}:start \\*/([\\s\\S]*?)/\\* @${name}:end \\*/`
  );
  const match = globalsCss.match(pattern);
  expect(match, `marker block @${name} missing from globals.css`).not.toBeNull();
  return match![1];
}

/** Parse `--name: value;` declarations out of a CSS block. */
function declarations(cssText: string): Record<string, string> {
  const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, "");
  const decls: Record<string, string> = {};
  for (const match of withoutComments.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    decls[match[1]] = match[2].trim();
  }
  return decls;
}

/**
 * The on-color foreground tokens: the `deriveOnColorForegrounds` choice key
 * (camelCase) paired with the emitted CSS variable name (kebab).
 */
const FOREGROUND_TOKENS = [
  ["accent", "--accent-foreground"],
  ["accentSecondary", "--accent-secondary-foreground"],
  ["accentWarm", "--accent-warm-foreground"],
  ["positive", "--positive-foreground"],
  ["negative", "--negative-foreground"],
] as const;

/** The light-adapted Signal palette, recomputed through the pipeline. */
function lightSignal() {
  return buildBrandKit({
    colors: {
      accent: SIGNAL_COLORS.accent,
      surface: SIGNAL_LIGHT_SURFACE,
      positive: SIGNAL_COLORS.positive,
      negative: SIGNAL_COLORS.negative,
    },
  });
}

describe("globals.css ↔ token-pipeline parity", () => {
  test("the dark :root block is exactly toCssVariables(SIGNAL_DEFAULT_TOKENS)", () => {
    const block = declarations(markedBlock("signal-tokens:dark"));
    expect(block).toEqual(toCssVariables(SIGNAL_DEFAULT_TOKENS));
  });

  test("the light blocks are exactly the buildBrandKit light adaptation (and pass the gate)", () => {
    const { kit, accessibility } = lightSignal();
    expect(accessibility.pass).toBe(true);

    const { colors } = kit.tokens;
    const expected: Record<string, string> = {
      "--surface": colors.surface,
      "--surface-raised": colors.surfaceRaised,
      "--ink": colors.ink,
      "--muted": colors.muted,
      "--accent": colors.accent,
      "--accent-secondary": colors.accentSecondary,
      "--accent-warm": colors.accentWarm,
      "--positive": colors.positive,
      "--negative": colors.negative,
    };
    const choices = deriveOnColorForegrounds(colors);
    for (const [key, cssName] of FOREGROUND_TOKENS) {
      expected[cssName] = `var(--${choices[key] === "surface" ? "surface" : "ink"})`;
    }

    // The media block and the [data-theme="light"] block must be identical
    // twins, and both must match the pipeline output.
    const lightBlock = markedBlock("signal-tokens:light");
    const media = lightBlock.match(/@media[\s\S]*?\{\s*:root[^{]*\{([\s\S]*?)\}/);
    const attribute = lightBlock.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\}/);
    expect(media).not.toBeNull();
    expect(attribute).not.toBeNull();
    expect(declarations(media![1])).toEqual(expected);
    expect(declarations(attribute![1])).toEqual(expected);
  });

  test("the dark derived foregrounds follow the deriveOnColorForegrounds rule", () => {
    const derived = declarations(markedBlock("signal-derived:dark"));
    const choices = deriveOnColorForegrounds(SIGNAL_COLORS);
    for (const [key, cssName] of FOREGROUND_TOKENS) {
      expect(derived[cssName]).toBe(
        `var(--${choices[key] === "surface" ? "surface" : "ink"})`
      );
    }
  });

  test("the Tailwind type-scale block matches the pipeline's --text-* variables", () => {
    const themeBlock = declarations(markedBlock("signal-tokens:type-scale"));
    const pipeline = toCssVariables(SIGNAL_DEFAULT_TOKENS);
    const pipelineText = Object.fromEntries(
      Object.entries(pipeline).filter(([name]) => name.startsWith("--text-"))
    );
    // Ignore the `--text-*: initial` namespace wipe; every real declaration
    // must match the pipeline exactly.
    delete themeBlock["--text-*" as keyof typeof themeBlock];
    expect(themeBlock).toEqual(pipelineText);
  });
});
