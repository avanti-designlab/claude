/**
 * QA F1 regression pin — the sweep route must kick the processor
 * UNCONDITIONALLY. The two sweep functions never touch a QUEUED row (reap =
 * running-only, requeue = failed-only), so a stale queued run whose enqueue
 * kick was dropped is recovered ONLY by a processor invocation; a kick gated on
 * `summary.requeued > 0` would strand it forever (the original F1 defect). This
 * reads the route source (importing it would pull the server-only live wiring),
 * mirroring route-config.test.ts, and fails loudly if the kick is ever made
 * conditional again.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SWEEP_ROUTE = fileURLToPath(new URL("../../app/api/runs/sweep/route.ts", import.meta.url));

describe("sweep route — unconditional processor kick (QA F1)", () => {
  const src = readFileSync(SWEEP_ROUTE, "utf8");

  it("kicks the processor", () => {
    expect(src).toMatch(/kickProcessor\("process"\)/);
  });

  it("does NOT gate the kick on requeued/reaped counts (that stranded queued rows)", () => {
    expect(src).not.toMatch(/if\s*\([^)]*requeued[^)]*\)\s*kickProcessor/);
    expect(src).not.toMatch(/if\s*\([^)]*reaped[^)]*\)\s*kickProcessor/);
    // The bare, unconditional statement form is present.
    expect(src).toMatch(/\n\s*kickProcessor\("process"\);/);
  });

  it("still declares the nodejs runtime (A2)", () => {
    expect(src).toMatch(/export const runtime = "nodejs";/);
  });
});
