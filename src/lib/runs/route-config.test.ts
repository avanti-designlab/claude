/**
 * A3 invariant at the ROUTE boundary. Next.js requires a route's `maxDuration`
 * to be a static literal (it cannot resolve an imported constant), so the
 * processor route hard-codes it. This test PINS that literal equal to the ONE
 * config constant (SCAN_MAX_DURATION_SECONDS) by reading the route source — so
 * the config constant remains the single source of truth and a drift between
 * the two fails loudly. (We read the file rather than import the route, which
 * would pull the server-only live wiring.)
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCAN_CRAWL_BUDGET_MS, SCAN_MAX_DURATION_SECONDS, SCAN_OVERHEAD_SECONDS } from "./config";

const ROUTE_PATH = fileURLToPath(new URL("../../app/api/runs/process/route.ts", import.meta.url));
const SWEEP_ROUTE_PATH = fileURLToPath(new URL("../../app/api/runs/sweep/route.ts", import.meta.url));

describe("processor route maxDuration ⇄ config constant", () => {
  it("the route's static maxDuration literal equals SCAN_MAX_DURATION_SECONDS", () => {
    const src = readFileSync(ROUTE_PATH, "utf8");
    const match = /export const maxDuration = (\d+);/.exec(src);
    expect(match, "route must export a numeric literal maxDuration").not.toBeNull();
    expect(Number(match![1])).toBe(SCAN_MAX_DURATION_SECONDS);
  });

  it("BOTH run routes declare nodejs runtime (A2: no edge runtime on the crawl path)", () => {
    for (const path of [ROUTE_PATH, SWEEP_ROUTE_PATH]) {
      const src = readFileSync(path, "utf8");
      expect(src, path).toMatch(/export const runtime = "nodejs";/);
    }
  });

  it("re-affirms the crawl budget stays within the route window (A3)", () => {
    expect(SCAN_CRAWL_BUDGET_MS).toBeLessThanOrEqual(
      (SCAN_MAX_DURATION_SECONDS - SCAN_OVERHEAD_SECONDS) * 1000
    );
  });
});
