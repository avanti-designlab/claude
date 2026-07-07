-- ============================================================================
-- 0001_app_helpers.sql — F1 foundation (doc 03): JWT claim helpers + shared
-- trigger + baseline schema grants.
--
-- IMPORTANT: the `auth` schema and `auth.jwt()` are SUPABASE-PROVIDED in every
-- real environment. Migrations NEVER create them. The local test harness
-- (supabase/tests/helpers/harness.ts) installs an exact shim BEFORE running
-- migrations — the shim, not a migration, owns `create schema auth`.
--
-- JWT claim contract (published: docs/contracts/data-model.md):
--   tenant_id  uuid-as-text  the caller's tenant. Missing/empty => every
--                            policy comparison is not-true => zero rows /
--                            no writes. Fail closed.
--   role       text          platform_owner | agency_admin | operator |
--                            client_viewer
--   client_id  uuid-as-text  present iff role = client_viewer
--   sub        uuid-as-text  Supabase auth user id (auth.users.id)
--
-- platform_owner NEVER receives rows through the tenant-facing policies in
-- these migrations (doc 03 §2: "never used to bypass tenant isolation in
-- tenant-facing queries"). Platform tooling runs server-side under Supabase
-- `service_role` (BYPASSRLS) with its own audit trail.
-- ============================================================================

create schema app;

-- ----------------------------------------------------------------------------
-- Claim readers. STABLE and NULL-safe: an absent or empty claim yields NULL,
-- and every policy comparison against NULL evaluates not-true => fail closed.
-- A malformed (non-uuid) claim raises a cast error — an error, never a leak.
-- ----------------------------------------------------------------------------

create function app.tenant_id() returns uuid
language sql stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'tenant_id', '')::uuid
$$;

create function app.user_role() returns text
language sql stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'role', '')
$$;

create function app.client_id() returns uuid
language sql stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'client_id', '')::uuid
$$;

create function app.auth_user_id() returns uuid
language sql stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

-- ----------------------------------------------------------------------------
-- Role predicates (doc 03 §2 role matrix).
--   is_admin  : agency_admin — manages users, clients, billing, all modules.
--   is_writer : agency_admin | operator — module/write rights.
-- Unknown or missing roles — including platform_owner — match neither: false.
-- ----------------------------------------------------------------------------

create function app.is_admin() returns boolean
language sql stable
set search_path = ''
as $$
  select app.user_role() = 'agency_admin'
$$;

create function app.is_writer() returns boolean
language sql stable
set search_path = ''
as $$
  select app.user_role() in ('agency_admin', 'operator')
$$;

-- Row visibility for client-scoped reads: agency staff (admin/operator) see
-- the whole tenant; client_viewer sees ONLY rows pinned to its own client_id
-- claim (doc 03 §2: a client_viewer can never see sibling clients). Any other
-- role => false (fail closed).
create function app.client_scope(row_client_id uuid) returns boolean
language sql stable
set search_path = ''
as $$
  select app.is_writer()
      or (app.user_role() = 'client_viewer' and row_client_id = app.client_id())
$$;

-- ----------------------------------------------------------------------------
-- Shared updated_at trigger for mutable tables.
-- ----------------------------------------------------------------------------

create function app.set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- ----------------------------------------------------------------------------
-- Grants. `anon` gets NOTHING on tenant data — no table grants exist for it
-- anywhere in these migrations; schema usage alone exposes no rows.
-- Policy expressions execute as the querying role, so `authenticated` needs
-- EXECUTE on the app.* helpers.
-- ----------------------------------------------------------------------------

grant usage on schema public to authenticated, anon;
grant usage on schema app to authenticated;
revoke all on all functions in schema app from public;
grant execute on all functions in schema app to authenticated;
