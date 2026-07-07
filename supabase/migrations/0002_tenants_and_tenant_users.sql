-- ============================================================================
-- 0002_tenants_and_tenant_users.sql — the tenancy root (doc 03 §1, §3).
--
-- tenants:      one row per agency. Carries white-label theming. Provisioning
--               (INSERT) and deprovisioning (DELETE) are platform operations —
--               service_role only; no authenticated policy grants them.
-- tenant_users: Supabase auth.users membership + role within a tenant.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TENANTS
-- ----------------------------------------------------------------------------

create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  -- White-label theme (doc 03 §1 + §3). Shape ratified at F1 (BUILD-STATE
  -- items 1–2): {logo_url, colors, font, custom_domain} with snake_case color
  -- keys and font = {display, body, mono} — exactly what toTenantTheme()
  -- (src/lib/skills/brand-kit/serialize.ts) emits.
  theme      jsonb,
  plan_tier  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenants_theme_is_object check (
    theme is null or jsonb_typeof(theme) = 'object'
  ),
  -- Ratified F1 item 1: singular doc-03 `font` is the three-face object.
  constraint tenants_theme_font_shape check (
    theme is null
    or theme -> 'font' is null
    or (
      jsonb_typeof(theme -> 'font') = 'object'
      and jsonb_typeof(theme -> 'font' -> 'display') = 'string'
      and jsonb_typeof(theme -> 'font' -> 'body') = 'string'
      and jsonb_typeof(theme -> 'font' -> 'mono') = 'string'
    )
  ),
  -- Ratified F1 item 2: snake_case color keys (doc 06 token names).
  constraint tenants_theme_colors_shape check (
    theme is null
    or theme -> 'colors' is null
    or (
      jsonb_typeof(theme -> 'colors') = 'object'
      and theme -> 'colors' ?& array[
        'surface', 'surface_raised', 'ink', 'muted',
        'accent', 'positive', 'negative'
      ]
    )
  )
);

comment on table public.tenants is
  'Tenancy root (doc 03 §1). INSERT/DELETE are platform operations via service_role only.';
comment on column public.tenants.theme is
  'White-label theme: {logo_url, colors, font, custom_domain}; snake_case color keys; font={display,body,mono}. Canonical producer: toTenantTheme() in src/lib/skills/brand-kit/serialize.ts (F1-ratified).';

create trigger set_updated_at
  before update on public.tenants
  for each row execute function app.set_updated_at();

alter table public.tenants enable row level security;
alter table public.tenants force row level security;

-- Every tenant role — including client_viewer, which renders the agency's
-- white-label brand (doc 03 §1) — may read its OWN tenant row only.
create policy tenants_select on public.tenants
  for select to authenticated
  using (
    id = app.tenant_id()
    and app.user_role() in ('agency_admin', 'operator', 'client_viewer')
  );

-- agency_admin manages tenant settings/billing/theme (doc 03 §2).
create policy tenants_update on public.tenants
  for update to authenticated
  using (id = app.tenant_id() and app.is_admin())
  with check (id = app.tenant_id() and app.is_admin());

-- No INSERT/DELETE policies: denied for authenticated (service_role only).
grant select, update on public.tenants to authenticated;

-- ----------------------------------------------------------------------------
-- TENANT_USERS
-- ----------------------------------------------------------------------------

create table public.tenant_users (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete restrict,
  -- Supabase auth.users.id. FK deliberately omitted: the auth schema is
  -- Supabase-managed and migrations must not depend on its tables
  -- (docs/contracts/data-model.md).
  auth_user_id uuid not null,
  role         text not null,
  -- Set ONLY for client_viewer (doc 03 §3). Composite FK to clients is added
  -- in 0003 (clients does not exist yet at this point in the order).
  client_id    uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- platform_owner is NOT a tenant membership role (doc 03 §2: it is
  -- cross-tenant/internal and never stored per-tenant).
  constraint tenant_users_role_allowed check (
    role in ('agency_admin', 'operator', 'client_viewer')
  ),
  constraint tenant_users_client_viewer_iff_client check (
    (role = 'client_viewer') = (client_id is not null)
  ),
  -- Composite-FK anchor: lets child rows prove "this user belongs to this
  -- tenant" structurally (tenant-consistency strategy, contracts doc).
  constraint tenant_users_tenant_id_id_key unique (tenant_id, id),
  -- One membership per auth user per tenant.
  constraint tenant_users_tenant_auth_key unique (tenant_id, auth_user_id)
);

comment on table public.tenant_users is
  'Tenant membership for Supabase auth users (doc 03 §3). Managed by agency_admin within the tenant.';

create trigger set_updated_at
  before update on public.tenant_users
  for each row execute function app.set_updated_at();

alter table public.tenant_users enable row level security;
alter table public.tenant_users force row level security;

-- Agency staff see the tenant's memberships; a client_viewer sees only its
-- own membership row (needed to resolve its own profile — nothing else).
create policy tenant_users_select on public.tenant_users
  for select to authenticated
  using (
    tenant_id = app.tenant_id()
    and (
      app.is_writer()
      or (app.user_role() = 'client_viewer' and auth_user_id = app.auth_user_id())
    )
  );

create policy tenant_users_insert on public.tenant_users
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_admin());

create policy tenant_users_update on public.tenant_users
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_admin())
  with check (tenant_id = app.tenant_id() and app.is_admin());

create policy tenant_users_delete on public.tenant_users
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_admin());

grant select, insert, update, delete on public.tenant_users to authenticated;
