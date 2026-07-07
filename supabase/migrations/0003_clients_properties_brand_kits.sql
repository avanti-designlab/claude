-- ============================================================================
-- 0003_clients_properties_brand_kits.sql — the client hierarchy (doc 03 §3).
--
-- Tenant-consistency strategy (applies to every child table from here on):
-- children reference parents through COMPOSITE foreign keys that carry
-- tenant_id — e.g. (tenant_id, client_id) -> clients (tenant_id, id) — so a
-- row can NEVER point at another tenant's client/property/plan/kit. The
-- parent tables expose matching UNIQUE constraints as FK anchors. Isolation
-- is structural, not just policy-enforced.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- CLIENTS
-- ----------------------------------------------------------------------------

create table public.clients (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete restrict,
  name       text not null,
  -- Seed five (cannabis | real-estate | restaurants | health-life-insurance |
  -- ecommerce) OR any M1b-generated vertical (doc 02 §2.6) — deliberately an
  -- open set, no CHECK. Mirrors `Vertical` in src/lib/types/playbook.ts.
  vertical   text not null,
  -- [{name, address, geo}] — drives the local module (doc 03 §3).
  locations  jsonb not null default '[]'::jsonb,
  status     text not null default 'onboarding',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint clients_locations_is_array check (jsonb_typeof(locations) = 'array'),
  -- Value set is doc-silent — chosen at F1, flagged for ratification
  -- (docs/contracts/data-model.md §9).
  constraint clients_status_allowed check (
    status in ('onboarding', 'active', 'paused', 'archived')
  ),
  -- Composite-FK anchor (tenant-consistency strategy).
  constraint clients_tenant_id_id_key unique (tenant_id, id)
);

comment on table public.clients is
  'An agency''s clients (doc 03 §1). Writes are agency_admin-only ("manage clients", doc 03 §2).';

create trigger set_updated_at
  before update on public.clients
  for each row execute function app.set_updated_at();

alter table public.clients enable row level security;
alter table public.clients force row level security;

create policy clients_select on public.clients
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(id));

create policy clients_insert on public.clients
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_admin());

create policy clients_update on public.clients
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_admin())
  with check (tenant_id = app.tenant_id() and app.is_admin());

create policy clients_delete on public.clients
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_admin());

grant select, insert, update, delete on public.clients to authenticated;

-- Now that clients exists: pin tenant_users.client_id to a client OF THE SAME
-- TENANT (deferred from 0002; tenant-consistency strategy).
alter table public.tenant_users
  add constraint tenant_users_client_fk
  foreign key (tenant_id, client_id)
  references public.clients (tenant_id, id) on delete restrict;

-- ----------------------------------------------------------------------------
-- PROPERTIES — a client's connected assets
-- ----------------------------------------------------------------------------

create table public.properties (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete restrict,
  client_id         uuid not null,
  -- website | gbp | instagram | linkedin | ... — open set per doc 03 §3.
  type              text not null,
  -- Site platform; meaningful for websites, nullable for gbp/social assets.
  platform          text,
  url               text not null,
  -- Reference into the secrets vault (Supabase Vault / external manager,
  -- DevOps-owned). NEVER a raw credential, token, or password (doc 03 §5).
  auth_ref          text,
  connection_method text not null default 'none',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint properties_platform_allowed check (
    platform is null
    or platform in ('wordpress', 'webflow', 'wix', 'framer', 'nextjs', 'custom')
  ),
  constraint properties_website_has_platform check (
    type <> 'website' or platform is not null
  ),
  constraint properties_connection_method_allowed check (
    connection_method in ('api', 'edge_worker', 'pr', 'none')
  ),
  -- Composite-FK anchors.
  constraint properties_tenant_id_id_key unique (tenant_id, id),
  constraint properties_tenant_client_id_key unique (tenant_id, client_id, id),
  -- Tenant-consistency: a property can only belong to a same-tenant client.
  constraint properties_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict
);

comment on column public.properties.auth_ref is
  'Secrets-vault reference ONLY (doc 03 §5). Raw credentials never live in any table.';

create trigger set_updated_at
  before update on public.properties
  for each row execute function app.set_updated_at();

alter table public.properties enable row level security;
alter table public.properties force row level security;

create policy properties_select on public.properties
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

create policy properties_insert on public.properties
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy properties_update on public.properties
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy properties_delete on public.properties
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.properties to authenticated;

-- ----------------------------------------------------------------------------
-- BRAND_KITS — locked brand system (feeds production + white-label)
-- ----------------------------------------------------------------------------

create table public.brand_kits (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete restrict,
  client_id     uuid not null,
  -- DesignTokenSet jsonb (src/lib/types/brand.ts) — colors/typography/spacing
  -- from the brand-kit-design-token skill. Keys are the TS camelCase shape
  -- (e.g. colors.surfaceRaised); only tenants.theme uses the snake_case
  -- projection (contracts doc §7).
  tokens        jsonb not null,
  -- VoiceProfile jsonb: {descriptors, samples, do, dont}.
  voice_profile jsonb not null,
  -- LikenessRefs jsonb: {higgsfieldElementIds, motionElementIds}.
  likeness_refs jsonb not null
    default '{"higgsfieldElementIds": [], "motionElementIds": []}'::jsonb,
  -- Client brand assets: {logo_url, ...}. Added at F1 (doc 05 M7 ingests the
  -- logo; doc 03''s sketch had no home for it) — feeds schema-generation''s
  -- SchemaBrandContext.logoUrl (ratification item 4, contracts doc §8).
  assets        jsonb,
  locked        boolean not null default false,
  version       int not null default 1,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint brand_kits_tokens_is_object check (jsonb_typeof(tokens) = 'object'),
  constraint brand_kits_voice_profile_is_object check (jsonb_typeof(voice_profile) = 'object'),
  constraint brand_kits_likeness_refs_is_object check (jsonb_typeof(likeness_refs) = 'object'),
  constraint brand_kits_assets_is_object check (
    assets is null or jsonb_typeof(assets) = 'object'
  ),
  constraint brand_kits_version_positive check (version >= 1),
  -- Composite-FK anchors.
  constraint brand_kits_tenant_id_id_key unique (tenant_id, id),
  constraint brand_kits_tenant_client_id_key unique (tenant_id, client_id, id),
  -- One kit row per client per version.
  constraint brand_kits_client_version_key unique (tenant_id, client_id, version),
  constraint brand_kits_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict
);

create trigger set_updated_at
  before update on public.brand_kits
  for each row execute function app.set_updated_at();

alter table public.brand_kits enable row level security;
alter table public.brand_kits force row level security;

create policy brand_kits_select on public.brand_kits
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

create policy brand_kits_insert on public.brand_kits
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy brand_kits_update on public.brand_kits
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy brand_kits_delete on public.brand_kits
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.brand_kits to authenticated;
