/**
 * Processor + sweeper request authentication — the A2 hardening seam.
 *
 * The internal run endpoints (POST /api/runs/process, /api/runs/sweep) are
 * guarded by a TIMING-SAFE shared-secret check:
 *  - the secret lives in env (RUNS_PROCESSOR_SECRET, server-only) and is NEVER
 *    logged (callers return a status only — no body echoes the presented or
 *    expected secret);
 *  - comparison is constant-time (fixed-length SHA-256 digests → timingSafeEqual,
 *    which never throws on a length mismatch and reveals nothing via timing);
 *  - env-UNSET fails CLOSED with a NON-500 refusal (503): a route with no secret
 *    configured refuses everyone rather than 500-ing or, worse, running open.
 *
 * Pure enough to unit-test in the default `npm test` run: the env map is
 * injectable, so the wrong-secret / missing-header / unset-env branches are all
 * exercised without a live server.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const PROCESSOR_SECRET_ENV = "RUNS_PROCESSOR_SECRET";

export type ProcessorAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: "unconfigured" | "unauthorized" };

/**
 * Constant-time secret comparison. We hash both sides to a fixed 32-byte digest
 * first so timingSafeEqual gets equal-length buffers (it throws otherwise, and
 * that throw would itself be a length oracle) — and the comparison time no
 * longer depends on where the first differing byte is.
 */
export function secretsMatch(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/**
 * Pull the presented secret from `Authorization: Bearer <secret>` (preferred) or
 * an `x-runs-secret` header. Returns null when neither is present/non-empty.
 */
export function presentedSecret(headers: Headers): string | null {
  const auth = headers.get("authorization");
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1].trim()) return m[1].trim();
  }
  const x = headers.get("x-runs-secret");
  if (x && x.trim()) return x.trim();
  return null;
}

/**
 * Authorize an internal run-endpoint request. Env is injectable for tests.
 * Order (all fail-closed): unset secret → 503 (unconfigured); no presented
 * secret → 401; mismatch → 401; match → ok. NEVER returns 500 for a config or
 * auth problem, and never logs either secret.
 */
export function authorizeProcessorRequest(
  headers: Headers,
  env: Record<string, string | undefined> = process.env
): ProcessorAuthResult {
  const expected = env[PROCESSOR_SECRET_ENV];
  if (!expected) return { ok: false, status: 503, reason: "unconfigured" };
  const presented = presentedSecret(headers);
  if (!presented) return { ok: false, status: 401, reason: "unauthorized" };
  if (!secretsMatch(presented, expected)) {
    return { ok: false, status: 401, reason: "unauthorized" };
  }
  return { ok: true };
}
