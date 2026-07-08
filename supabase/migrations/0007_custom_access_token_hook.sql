-- ============================================================================
-- 0007_custom_access_token_hook.sql — the SERVER-SIDE claim-minting layer.
--
-- AUTHORIZED additive change to the frozen F1 foundation (migrations 0001-0006
-- are frozen and untouched). Adds the Supabase Custom Access Token hook that
-- mints the tenant claims RLS trusts (doc 03 §4; contract §2, §3). Goes through
-- the Code Review security + tenant-isolation gate before freeze.
--
-- ────────────────────────────────────────────────────────────────────────────
-- THE CORE SECURITY PROPERTY
-- ────────────────────────────────────────────────────────────────────────────
-- The claims RLS keys off — tenant_id, user_role, client_id (app.tenant_id() /
-- app.user_role() / app.client_id() in 0001+0008) — are minted HERE,
-- server-side, SOLELY from `public.tenant_users`, keyed off the authenticated
-- user id that GoTrue passes in the hook event (event->>'user_id'). They are
-- NEVER sourced from anything the client sends:
--   * any pre-existing tenant_id / user_role / client_id in the incoming token
--     is DISCARDED and re-derived (a forged/replayed/stale token cannot escalate
--     — proven by test);
--   * `user_role` is minted ONLY from a real membership => that membership's app
--     role; NO membership => NO `user_role` is minted (no app privileges);
--   * a `client_viewer` therefore cannot influence its own tenant_id / user_role
--     / client_id claim (the ratified upstream obligation, contract §3).
-- If the user has no tenant_users row, NO tenant claims are minted: they can
-- authenticate but every RLS policy fails closed => they see nothing.
--
-- The APP role travels in the NON-reserved `user_role` claim (migration 0008).
-- We NEVER touch the standard `role` claim: that is PostgREST's reserved DB-role
-- claim, which GoTrue sets to 'authenticated' for every signed-in user, and
-- which drives PostgREST's `SET ROLE`. Leaving it as GoTrue set it is what keeps
-- production requests running as `authenticated` — the request role every RLS
-- policy targets and the isolation suite exercises. (See 0008 header + the note
-- at the foot of this header.)
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS SECURITY DEFINER, AND WHY IT CAN READ tenant_users
-- ────────────────────────────────────────────────────────────────────────────
-- The hook runs during token minting, when there is NO JWT context yet
-- (auth.jwt() is null), so it cannot satisfy the RLS policies on tenant_users
-- (which is FORCE ROW LEVEL SECURITY). It is therefore SECURITY DEFINER: it
-- executes as its OWNER (the migration runner — `postgres` in Supabase, the
-- superuser in the test harness), which bypasses RLS. This is why NO RLS policy
-- for supabase_auth_admin is added to tenant_users (which would also break the
-- posture invariant "every policy targets `authenticated` only"). GoTrue calls
-- the hook as `supabase_auth_admin`; that role only needs EXECUTE on the
-- function (granted below) — the table read happens as the definer.
--   Assumption (documented for Code Review): `postgres` has BYPASSRLS in
--   Supabase (the same reason the dashboard SQL editor bypasses RLS). If a
--   deployment's migration runner lacks BYPASSRLS, the read returns nothing and
--   the hook fails closed (no claims minted for anyone — a loud, safe failure,
--   never a leak); see docs/ops/environments.md for the remedy.
--
-- ────────────────────────────────────────────────────────────────────────────
-- OPERATOR ACTION REQUIRED — THIS MIGRATION DOES NOT AUTO-ENABLE THE HOOK
-- ────────────────────────────────────────────────────────────────────────────
-- Supabase does not run a Custom Access Token hook until it is enabled in the
-- dashboard: Authentication → Hooks (Custom Access Token) → select
-- `auth_hooks.custom_access_token_hook`. Until then tokens carry NO tenant
-- claims and every request fails closed. See docs/ops/environments.md.
--
-- RESERVED `role` CLAIM — RESOLVED (Orchestrator + Code Review, 2026-07-08).
-- Earlier this hook minted the app role into the `role` claim, colliding with
-- PostgREST's reserved DB-role claim: the first logged-in supabase-js data query
-- would `SET ROLE <app role>` and fail. Resolution — Option 2: the app role now
-- travels in the NON-reserved `user_role` claim (migration 0008 re-points
-- `app.user_role()` there), and this hook LEAVES GoTrue's `role=authenticated`
-- untouched. PostgREST therefore keeps `SET ROLE authenticated` — the request
-- role every RLS policy targets and the 399-test isolation suite exercises. No
-- grantable app Postgres roles are introduced; production runs in the same
-- `authenticated` role the suite proves. See migration 0008 and
-- docs/ops/environments.md.
-- ============================================================================

-- Locked-down schema: only the GoTrue DB user (supabase_auth_admin) may reach
-- into it. A freshly created schema grants PUBLIC nothing, but be explicit.
create schema if not exists auth_hooks;
revoke all on schema auth_hooks from public;

-- ----------------------------------------------------------------------------
-- The hook. Signature is fixed by Supabase: (event jsonb) returns jsonb, where
-- event = { user_id, claims, authentication_method } and the return value is
-- the event with a (re)built `claims` object.
-- ----------------------------------------------------------------------------
create function auth_hooks.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id   uuid;
  v_claims    jsonb;
  v_tenant_id uuid;
  v_role      text;
  v_client_id uuid;
  v_found     boolean := false;
begin
  -- The ONLY trusted identity input: the authenticated user id GoTrue signs
  -- into the event. Everything else in event->'claims' is untrusted.
  v_user_id := nullif(event ->> 'user_id', '')::uuid;
  v_claims  := coalesce(event -> 'claims', '{}'::jsonb);

  -- Discard any incoming APP claims BEFORE deriving. This is what makes a
  -- forged/replayed/stale token unable to carry tenant_id/user_role/client_id
  -- through: whatever the caller put there is gone; we rebuild only from
  -- tenant_users. We deliberately do NOT strip `role` — that is PostgREST's
  -- reserved DB-role claim, owned by GoTrue (always 'authenticated'); the app
  -- role lives in the non-reserved `user_role` claim (migration 0008).
  v_claims := v_claims - 'tenant_id' - 'client_id' - 'user_role';

  -- Derive the membership from tenant_users, keyed ONLY by the authenticated
  -- user id. `order by ... limit 1` makes the (currently unsupported)
  -- multi-tenant-membership case DETERMINISTIC: the oldest membership wins,
  -- then the lowest id. Single-tenant membership is the norm today; true
  -- multi-tenant users / tenant-switching (a token that selects an active
  -- tenant) is a future capability, documented as a known limitation.
  select tu.tenant_id, tu.role, tu.client_id
    into v_tenant_id, v_role, v_client_id
  from public.tenant_users tu
  where tu.auth_user_id = v_user_id
  order by tu.created_at asc, tu.id asc
  limit 1;
  v_found := found;

  if v_found then
    -- Re-derive tenant_id + the app role ENTIRELY from tenant_users. The app
    -- role goes into the NON-reserved `user_role` claim (app.user_role() reads
    -- it — migration 0008); uuid/text as JSON strings so the app.* readers'
    -- `->> '...'::uuid` / text casts work.
    v_claims := v_claims
      || jsonb_build_object('tenant_id', v_tenant_id::text)
      || jsonb_build_object('user_role', v_role);

    -- client_id ONLY for client_viewer (tenant_users CHECK guarantees it is
    -- non-null exactly then). Any other role carries no client_id claim.
    if v_role = 'client_viewer' then
      v_claims := v_claims
        || jsonb_build_object('client_id', v_client_id::text);
    end if;
  end if;
  -- No membership => mint NO app claims (tenant_id/user_role/client_id were all
  -- stripped above and none re-minted). We do NOT touch `role`: GoTrue already
  -- set it to the base 'authenticated' DB-role, and overwriting PostgREST's
  -- reserved claim is exactly the collision Option 2 removes. With no user_role
  -- and no tenant_id, app.user_role() matches no app role and every RLS policy
  -- fails closed. Fail closed.

  return jsonb_set(event, '{claims}', v_claims);
end;
$$;

comment on function auth_hooks.custom_access_token_hook(jsonb) is
  'Supabase Custom Access Token hook. Mints tenant_id/user_role/client_id SOLELY from public.tenant_users keyed off the authenticated event->>''user_id''; discards any client-supplied app claims (tenant_id/user_role/client_id); leaves GoTrue''s reserved role=authenticated claim untouched; fails closed (no app claims minted) when the user has no membership. The app role travels in the non-reserved user_role claim (migration 0008). Enable in Dashboard → Authentication → Hooks. See migration header + docs/ops/environments.md.';

-- ----------------------------------------------------------------------------
-- Grants. GoTrue invokes the hook as supabase_auth_admin; nobody else may.
-- (supabase_auth_admin is Supabase-provided in real projects; the test harness
-- pre-creates it as a NOLOGIN role — same pattern as authenticated/anon.)
-- A newly created function grants EXECUTE to PUBLIC by default — REVOKE that
-- first, then grant only to supabase_auth_admin, so authenticated/anon (members
-- of PUBLIC) can never call this SECURITY DEFINER function.
-- ----------------------------------------------------------------------------
revoke execute on function auth_hooks.custom_access_token_hook(jsonb) from public;
revoke execute on function auth_hooks.custom_access_token_hook(jsonb) from authenticated, anon;
grant usage on schema auth_hooks to supabase_auth_admin;
grant execute on function auth_hooks.custom_access_token_hook(jsonb) to supabase_auth_admin;
