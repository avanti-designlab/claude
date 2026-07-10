-- ============================================================================
-- 0014_brand_assets.sql — the client brand ASSET LIBRARY (the platform's FIRST
-- object-storage-backed table).
--
-- Governed post-freeze change (CLAUDE.md rule 1), authorized by the Orchestrator
-- ruling recorded in docs/BUILD-STATE.md. Follows the doc 03 §3/§4 pattern
-- exactly (mirrors brand_kits 0003 / runs 0011): tenant_id + client_id, RLS
-- ENABLED and FORCED, composite FK (tenant_id, client_id) → clients, tenant_id-
-- leading index.
--
-- OPERATOR REQUIREMENT (verbatim): assets organized "separately by each client
-- so that branding doesn't get mixed up and every client has their own home of
-- assets." Realized here as a per-CLIENT, MUTABLE library — an asset attaches to
-- the client, never to a brand_kit VERSION (Orchestrator ruling, condition 1).
-- A locked brand_kits version may still REFERENCE specific asset ids/paths as an
-- immutable snapshot (mirroring likeness_refs) via the frozen `brand_kits.assets`
-- open jsonb (`assets.asset_refs`); changing the library never mutates a locked
-- kit. The remove/replace ACTIONS enforce that no locked-kit reference is ever
-- left dangling (src/lib/brand-assets/ — the on-delete-restrict discipline
-- applied to storage: archive-not-delete when referenced).
--
-- STORAGE IS A SEPARATE ISOLATION SURFACE. Raw bytes NEVER live in this table —
-- `storage_path` is the auth_ref-analog (doc 03 §5), a pointer into a PRIVATE
-- Supabase Storage bucket. The bucket + its storage.objects RLS policies are
-- provisioned OUTSIDE this migration (Supabase's `storage` schema is service-
-- provided and is NOT present in the local isolation harness, so a
-- `create policy on storage.objects` here would break every migration run):
-- see supabase/storage/brand-assets-bucket.sql and docs/ops/environments.md.
-- Path→tenant binding is enforced INDEPENDENTLY in two places (defense in depth,
-- never path obscurity alone):
--   (a) THIS table: the `brand_assets_path_scoped` CHECK forces storage_path to
--       begin with the row's OWN tenant_id/client_id — below RLS, holds even for
--       the superuser, so a row can never point at another tenant's object path.
--   (b) storage.objects RLS: the bucket policy re-checks the caller's JWT
--       tenant_id (and, for client_viewer, client_id) against the object path's
--       segments — a NEW isolation surface distinct from this table's RLS.
-- ============================================================================

create table public.brand_assets (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete restrict,
  client_id    uuid not null,
  -- Closed asset taxonomy (Orchestrator ruling, condition 2). Any future type is
  -- a governed post-freeze CHECK change, never an open write.
  type         text not null,
  -- Optional operator-facing label ("Primary logo — dark", ...). Bounded.
  label        text,
  -- Variant metadata (bounded jsonb object): e.g. {"width":512,"height":512,
  -- "background":"transparent","dominant":"#0b0b0f"}. Presentation hints only —
  -- NEVER credentials, URLs, or raw bytes. Size-bounded structurally below.
  variants     jsonb not null default '{}'::jsonb,
  -- The auth_ref-analog (doc 03 §5): the object's path inside the PRIVATE
  -- `brand-assets` bucket. Raw bytes never live in any table. The path embeds
  -- tenant_id/client_id (see brand_assets_path_scoped) AND is independently
  -- re-checked by the bucket's storage.objects RLS against the caller's JWT.
  storage_path text not null,
  -- Real object metadata, VERIFIED against storage on finalize (never trusted
  -- from the browser's claim). MIME allowlist = raster images + SVG.
  content_type text not null,
  size_bytes   bigint not null,
  -- Soft-delete marker. remove() sets this (KEEPING the object) when a LOCKED
  -- brand_kit version references the asset — never dangle an immutable kit's
  -- snapshot; a hard delete of row+object is allowed only when UNreferenced.
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint brand_assets_type_allowed check (
    type in (
      'primary_logo', 'secondary_logo', 'mono_logo', 'reversed_logo',
      'favicon', 'icon', 'imagery', 'other'
    )
  ),
  constraint brand_assets_label_len check (
    label is null or char_length(label) <= 120
  ),
  constraint brand_assets_variants_is_object check (jsonb_typeof(variants) = 'object'),
  -- Bounded jsonb (serialized) — a structural backstop under the action clamp.
  constraint brand_assets_variants_bounded check (char_length(variants::text) <= 4096),
  -- MIME allowlist (raster + SVG) — the bucket's allowed_mime_types is the first
  -- gate at PUT time; this CHECK is the table-layer backstop.
  constraint brand_assets_content_type_allowed check (
    content_type in (
      'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml'
    )
  ),
  -- Size cap = 10 MiB (⚑ ratify default; document + BRAND_ASSET_MAX_BYTES). The
  -- bucket's file_size_limit is the PUT-time gate; this is the backstop.
  constraint brand_assets_size_positive check (size_bytes > 0),
  constraint brand_assets_size_capped check (size_bytes <= 10485760),
  constraint brand_assets_storage_path_len check (
    char_length(storage_path) between 1 and 1024
  ),
  -- PATH IS TENANT/CLIENT-SCOPED, structurally. storage_path MUST begin with
  -- "<tenant_id>/<client_id>/", be EXACTLY one more segment (no deeper nesting or
  -- empty segment), and contain NO ".." traversal anywhere. Below RLS — a row can
  -- never claim an object path outside its own tenant/client, even for the
  -- superuser. (tenant/client ids are uuids; their text form contains only hex +
  -- '-', neither a LIKE metacharacter, so the prefix match is exact.) Defense in
  -- depth: the storage RLS keys off the LITERAL first segment and validate.ts
  -- also rejects '..'/nested paths — this is the third, structural layer.
  constraint brand_assets_path_scoped check (
    storage_path like tenant_id::text || '/' || client_id::text || '/%'
    -- exactly one trailing segment: forbid a further "/" (deeper folder or empty).
    and storage_path not like tenant_id::text || '/' || client_id::text || '/%/%'
    -- no parent-traversal component anywhere in the key.
    and position('..' in storage_path) = 0
  ),
  -- One row per object — a stored object is owned by exactly one asset row (a
  -- table-layer guard against path reuse / two rows sharing one object).
  constraint brand_assets_storage_path_key unique (storage_path),
  -- Composite-FK anchors + tenant-consistency (doc 03 §4 strategy).
  constraint brand_assets_tenant_id_id_key unique (tenant_id, id),
  constraint brand_assets_tenant_client_id_key unique (tenant_id, client_id, id),
  constraint brand_assets_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict
);

comment on table public.brand_assets is
  'Per-client brand asset library (Orchestrator ruling 2026-07-10). Mutable; assets attach to the CLIENT. Raw bytes live in the PRIVATE brand-assets Storage bucket — storage_path is the only pointer (doc 03 §5). Bucket + storage.objects RLS are provisioned via supabase/storage/brand-assets-bucket.sql.';

comment on column public.brand_assets.storage_path is
  'Path into the PRIVATE brand-assets bucket, "<tenant_id>/<client_id>/<uuid>[.ext]". The auth_ref-analog (doc 03 §5): raw bytes never in any table. Access ONLY via server-generated signed URLs issued after a tenant/client authz check.';

-- tenant_id-leading index — the per-client library list (newest first) AND the
-- smoke "tenant_id-leading index everywhere" assertion. Live rows are the common
-- read; archived rows are retained for locked-kit snapshots.
create index brand_assets_client_created_idx
  on public.brand_assets (tenant_id, client_id, created_at desc);

create trigger set_updated_at
  before update on public.brand_assets
  for each row execute function app.set_updated_at();

alter table public.brand_assets enable row level security;
alter table public.brand_assets force row level security;

-- SELECT: staff (agency_admin | operator) see the whole tenant; client_viewer
-- sees ONLY its own client's assets (app.client_scope — its own "home of
-- assets", the white-label brand surface). Mirrors brand_kits_select exactly.
create policy brand_assets_select on public.brand_assets
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

-- Writes at the is_writer floor (agency_admin | operator) — brand production is
-- operator work (doc 03 §2). RLS re-pins tenant scope below every action.
create policy brand_assets_insert on public.brand_assets
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy brand_assets_update on public.brand_assets
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy brand_assets_delete on public.brand_assets
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.brand_assets to authenticated;

/* ============================ DOWN (manual rollback — NOT executed) ==========
   The migration runner executes ONLY the UP above; a devops rollback step runs:

   drop table if exists public.brand_assets;

   The storage bucket + its storage.objects policies are rolled back separately
   (supabase/storage/brand-assets-bucket.sql documents the DOWN there).
============================================================================ */
