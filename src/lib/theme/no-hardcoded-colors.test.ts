/**
 * Doc 06 §3: "If any color/logo is hardcoded, it's a bug the Designer + Code
 * Review reject." This test automates the Designer half: no literal color
 * may appear in any component or app file. The only places a literal color
 * value may live are the token definitions in globals.css and the demo
 * tenant-theme INPUTS (which play the role of `tenants.theme` rows).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const SRC_ROOT = new URL("../..", import.meta.url).pathname;

/** Files allowed to contain literal colors, relative to src/. */
const ALLOWED = new Set([
  "app/globals.css", // the token definitions themselves (parity-tested)
  "lib/theme/demo-themes.ts", // demo tenants.theme rows — pipeline INPUTS
  "lib/theme/light-surface.ts", // the Signal light-surface token definition
]);

/** Directories under src/ owned by F2 and subject to the rule. */
const SCANNED_DIRS = ["app", "components", "lib/theme"];

const HEX_COLOR = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(/;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.(tsx?|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      yield full;
    }
  }
}

describe("no hardcoded brand values outside the token definitions (doc 06 §3)", () => {
  test("no hex literals or color functions in app/component/theme sources", () => {
    const violations: string[] = [];
    for (const dir of SCANNED_DIRS) {
      for (const file of walk(join(SRC_ROOT, dir))) {
        const rel = relative(SRC_ROOT, file);
        if (ALLOWED.has(rel)) continue;
        const content = readFileSync(file, "utf8");
        for (const [index, line] of content.split("\n").entries()) {
          // color-mix over var(--token) is a derivation, not a literal.
          const stripped = line.replace(/var\(--[\w-]+\)/g, "");
          if (HEX_COLOR.test(stripped) || COLOR_FUNCTION.test(stripped)) {
            violations.push(`${rel}:${index + 1}: ${line.trim()}`);
          }
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});
