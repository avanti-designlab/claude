-- ============================================================================
-- 0008_app_role_from_user_role_claim.sql — resolve the reserved-claim collision.
--
-- AUTHORIZED post-freeze change to the F1 auth layer. Direction chosen by the
-- Orchestrator (escalation resolution, 2026-07-08); Code Review verifies the
-- security + tenant-isolation gate next. Migrations 0001–0006 stay frozen and
-- untouched; migration 0007 (the claim-minting hook) is part of this SAME
-- in-flight, not-yet-gated auth layer and is edited in lockstep (see below).
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHAT CHANGED
-- ────────────────────────────────────────────────────────────────────────────
-- `app.user_role()` (defined in 0001) now reads the app role from the
-- **`user_role`** JWT claim instead of the **`role`** claim. Nothing else about
-- the function changes: same name, same signature, same STABLE / NULL-safe /
-- `search_path = ''` posture. It is the SINGLE source the RLS role predicates
-- (`app.is_admin()`, `app.is_writer()`, `app.client_scope()`) and the tenant/
-- membership SELECT policies key off, so replacing this one reader re-points
-- the entire frozen policy surface at the new claim with no policy edits.
--
-- ONLY the app-ROLE source moves. `app.tenant_id()` (reads `tenant_id`) and
-- `app.client_id()` (reads `client_id`) are deliberately left exactly as 0001
-- defined them — those claim names are not reserved and do not change.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHY — PostgREST's RESERVED `role` CLAIM
-- ────────────────────────────────────────────────────────────────────────────
-- `role` is PostgREST's reserved DB-role claim: on every request PostgREST does
-- `SET ROLE <the token's role claim>`. The frozen RLS read the APP role from
-- that same `role` claim, so minting `role = agency_admin|operator|
-- client_viewer` would make the first logged-in supabase-js data query try
-- `SET ROLE agency_admin` — a role that does not exist as a grantable Postgres
-- role — and fail. Auth itself (login, refresh, getClaims) worked; the first
-- logged-in *data query* was blocked. (Escalation documented in the 0007 header,
-- docs/ops/environments.md, and contract §12.)
--
-- RESOLUTION — Option 2 (Orchestrator's choice): move the APP role to a
-- NON-reserved claim (`user_role`) and LEAVE `role` as GoTrue sets it
-- (`authenticated`). PostgREST therefore keeps doing `SET ROLE authenticated` —
-- exactly the request role every RLS policy targets (`... to authenticated`)
-- AND the exact role the 399 isolation tests already exercise. Test fidelity was
-- the deciding factor: production runs in the same `authenticated` role the
-- suite proves, rather than in untested, newly-introduced grantable app roles.
--
-- FULL SWITCH, no fallback: the reader reads `user_role` ONLY. A COALESCE back
-- to `role` would leave the reserved-claim collision half-alive and give the app
-- role two possible sources — one source of truth, deliberately.
--
-- ────────────────────────────────────────────────────────────────────────────
-- COORDINATED WITH migration 0007 (edited in lockstep — noted for the reviewer)
-- ────────────────────────────────────────────────────────────────────────────
-- The Custom Access Token hook (0007) is edited in the same change to mint the
-- app role into `user_role` (never `role`), leaving GoTrue's `role=authenticated`
-- untouched, and — on no membership — minting NO `user_role`/`tenant_id`/
-- `client_id` (fail closed) while leaving `role=authenticated`. The hook also now
-- strips any incoming `user_role` (alongside `tenant_id`/`client_id`) before
-- re-deriving, so a stale/forged app role cannot ride through a refresh. 0007 is
-- part of this same not-yet-committed auth layer, so it is edited directly rather
-- than superseded; this migration and 0007 are one atomic resolution.
--
-- After this migration + the 0007 edit, the ONLY place the app role is read from
-- the JWT is this reader (claim `user_role`); nothing anywhere still reads the
-- reserved `role` claim as an app role.
-- ============================================================================

create or replace function app.user_role() returns text
language sql stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'user_role', '')
$$;

comment on function app.user_role() is
  'Reads the APP role from the NON-reserved `user_role` JWT claim (migration 0008 — resolves the PostgREST reserved-`role`-claim collision; Option 2, Orchestrator-authorized). `role` stays GoTrue''s reserved DB-role claim (authenticated). tenant_id/client_id readers are unaffected.';
