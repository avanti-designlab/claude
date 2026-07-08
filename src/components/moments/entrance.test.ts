/**
 * Entrance choreography — the brand's motion signature (operator direction,
 * 2026-07-08). Guards:
 * (a) the timing contract — 90ms stagger, 520ms rise, counters start only
 *     after their tile has landed, bloom follows the rise,
 * (b) the CSS side in globals.css — keyframes exist, transforms/opacity only
 *     (zero layout shift), and BOTH reduced-motion gates disable it (the OS
 *     media query and the design-system force-toggle attribute).
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  counterDelayMs,
  entranceDelayMs,
  ENTRANCE_BLOOM_DELAY_MS,
  ENTRANCE_DURATION_MS,
  ENTRANCE_SETTLE_MS,
  ENTRANCE_STAGGER_MS,
} from "./entrance";

const globalsCss = readFileSync(
  new URL("../../app/globals.css", import.meta.url),
  "utf8"
);

describe("entrance timing contract", () => {
  test("stagger/duration sit inside the operator-approved envelope", () => {
    expect(ENTRANCE_STAGGER_MS).toBeGreaterThanOrEqual(80);
    expect(ENTRANCE_STAGGER_MS).toBeLessThanOrEqual(120);
    expect(ENTRANCE_DURATION_MS).toBeGreaterThanOrEqual(400);
    expect(ENTRANCE_DURATION_MS).toBeLessThanOrEqual(600);
  });

  test("sibling steps stagger linearly; negative/fractional steps clamp sanely", () => {
    expect(entranceDelayMs(0)).toBe(0);
    expect(entranceDelayMs(1)).toBe(ENTRANCE_STAGGER_MS);
    expect(entranceDelayMs(4)).toBe(4 * ENTRANCE_STAGGER_MS);
    expect(entranceDelayMs(-2)).toBe(0);
  });

  test("counters start only after their tile has visibly landed", () => {
    expect(ENTRANCE_SETTLE_MS).toBeGreaterThan(0);
    expect(counterDelayMs(3)).toBe(entranceDelayMs(3) + ENTRANCE_SETTLE_MS);
    // A later tile's counter never fires before an earlier tile's counter.
    expect(counterDelayMs(2)).toBeGreaterThan(counterDelayMs(1));
  });

  test("the bloom follows the rise (card lands, then lights)", () => {
    expect(ENTRANCE_BLOOM_DELAY_MS).toBeGreaterThan(0);
    expect(ENTRANCE_BLOOM_DELAY_MS).toBeLessThanOrEqual(ENTRANCE_DURATION_MS);
  });
});

describe("entrance CSS (globals.css)", () => {
  test("keyframes animate opacity/transform (rise) and box-shadow (bloom) ONLY — zero layout shift", () => {
    const rise = globalsCss.match(/@keyframes entrance-rise \{([\s\S]*?)\n\}/);
    expect(rise).not.toBeNull();
    const riseProps = [...rise![1].matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(riseProps.sort()).toEqual(["opacity", "transform"]);

    const bloom = globalsCss.match(/@keyframes entrance-bloom \{([\s\S]*?)\n\}/);
    expect(bloom).not.toBeNull();
    const bloomProps = [...bloom![1].matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(bloomProps).toEqual(["box-shadow"]);
  });

  test("the rise duration/ease in CSS match the documented signature", () => {
    expect(globalsCss).toContain(
      `animation: entrance-rise ${ENTRANCE_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1) backwards;`
    );
    expect(globalsCss).toContain(
      `animation-delay: calc(var(--entrance-delay, 0ms) + ${ENTRANCE_BLOOM_DELAY_MS}ms);`
    );
  });

  test("the OS reduced-motion media query disables the entrance (instant final state)", () => {
    const media = globalsCss.match(
      /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/
    );
    expect(media).not.toBeNull();
    expect(media![1]).toContain(".entrance-item");
    expect(media![1]).toContain(".entrance-bloom");
    expect(media![1]).toContain("animation: none;");
  });

  test("the design-system force-toggle attribute disables the entrance too", () => {
    expect(globalsCss).toMatch(
      /:root\[data-motion="reduced"\] \.entrance-item,\s*\n:root\[data-motion="reduced"\] \.entrance-bloom \{\s*\n\s*animation: none;/
    );
  });

  test("fill mode is `backwards` — properties are released after the run (hover transitions keep working)", () => {
    expect(globalsCss).not.toMatch(/entrance-(rise|bloom)[^;]*\bboth\b/);
  });
});
