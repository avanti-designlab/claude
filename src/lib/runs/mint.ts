/**
 * Per-run tenant-claims minting — the heart of the A1 data-access model.
 *
 * After the cross-tenant lease (the ONE service-role-class op), the processor
 * must do every tenant read/write through an RLS-enforced client scoped to the
 * LEASED RUN'S TENANT — never service-role. This mints exactly that scope: a
 * short-lived HS256 JWT carrying the run's `tenant_id` and a WRITER app role,
 * signed with the project's JWT secret so PostgREST verifies it and applies the
 * SAME RLS every real operator of that tenant gets (app.tenant_id() =
 * tenant_id, app.is_writer() = true). The processor attaches this token to a
 * supabase-js client (src/lib/runs/live.ts); RLS then pins every subsequent row
 * to the run's tenant, so a bug in the processor cannot cross tenants — the
 * database refuses it.
 *
 * WHY minted, not service-role: the ruling forbids any other service-role use on
 * the run path (Code Review auto-rejects it). A per-run minted token is the
 * "per-run tenant-claims JWT" the ruling names; this is not a silent downgrade.
 *
 * Least privilege:
 *  - `user_role: "operator"` — a WRITER (audits insert, runs update) but NOT an
 *    agency_admin (no client/user/billing management). The minimal role that can
 *    run a scan and complete its own run.
 *  - `sub`: a fixed system-processor sentinel (never a real auth user). No RLS
 *    policy the processor touches keys off `sub` (audits/properties/clients/runs
 *    key off tenant_id + is_writer/client_scope), so it is inert — present only
 *    to satisfy the app.auth_user_id()::uuid cast shape.
 *  - short `exp` (default = maxDuration window + slack): the token is useless
 *    the moment the run's window closes.
 *
 * Pure: the secret is INJECTED (never read from env here) and the clock is
 * injectable, so this is unit-tested in the default `npm test` run — the test
 * re-verifies the HS256 signature and decodes the claims.
 */

import { createHmac } from "node:crypto";

/** Fixed system-processor identity — NEVER a real user (see header). */
export const SYSTEM_PROCESSOR_SUB = "00000000-0000-0000-0000-000000000000";

/** Default token lifetime (seconds): the maxDuration window plus slack. Kept
 *  here (not config.ts) because it is a security parameter of the mint, and the
 *  route/crawl-budget knobs must not silently widen a token's life. */
export const RUN_JWT_TTL_SECONDS = 120;

export interface MintRunJwtInput {
  /** The leased run's tenant — the ONLY tenant this token can ever see. */
  tenantId: string;
  /** The Supabase JWT secret PostgREST verifies against (env.server, injected). */
  secret: string;
  /** Injectable clock in seconds (default: floor(Date.now()/1000)). */
  nowSeconds?: number;
  /** Token lifetime; default RUN_JWT_TTL_SECONDS. */
  ttlSeconds?: number;
  /** Optional issuer claim (Supabase auth URL); cosmetic — PostgREST does not
   *  require it, but including it matches a real GoTrue token's shape. */
  issuer?: string;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Mint a run-scoped HS256 access token. The claim shape mirrors what the Custom
 * Access Token hook (migration 0007) mints for a real operator: the reserved
 * `role` stays `authenticated` (PostgREST's SET ROLE target), the APP role rides
 * the non-reserved `user_role` claim (app.user_role(), migration 0008), and
 * `tenant_id` drives app.tenant_id(). RLS treats it identically.
 */
export function mintRunJwt(input: MintRunJwtInput): string {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? RUN_JWT_TTL_SECONDS;

  const header = { alg: "HS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    aud: "authenticated",
    role: "authenticated", // reserved PostgREST DB-role claim (SET ROLE target)
    user_role: "operator", // app writer role (app.is_writer())
    tenant_id: input.tenantId,
    sub: SYSTEM_PROCESSOR_SUB,
    iat: now,
    exp: now + ttl,
  };
  if (input.issuer) payload.iss = input.issuer;

  const signingInput = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signature = createHmac("sha256", input.secret)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}
