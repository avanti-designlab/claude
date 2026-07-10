-- ============================================================================
-- brand-assets-bucket.sql — PROVISION the private brand-assets Storage bucket
-- and its storage.objects RLS policies.
--
-- ░░ NOT RUN BY THE MIGRATION RUNNER ░░  Supabase's `storage` schema is service-
-- provided; it does NOT exist in the local isolation harness, so this SQL must
-- never live in supabase/migrations/ (it would break every migration run). The
-- OPERATOR applies this file to a live Supabase project (STAGING FIRST), per
-- docs/ops/environments.md. The storage-isolation test
-- (supabase/tests/storage/brand-assets-storage.pg.test.ts) applies THIS SAME
-- file against a Supabase-exact storage shim so the policies are tested, not
-- just asserted-by-eye.
--
-- Prereqs (already true in a real project, installed by the harness/test shim):
--   - schema `storage` with table `storage.objects` and function
--     `storage.foldername(text) returns text[]` (Supabase-provided);
--   - schema `app` with app.tenant_id()/app.user_role()/app.is_writer()/
--     app.client_id() (migrations 0001/0008) — EXECUTE granted to authenticated;
--   - `auth.jwt()` (Supabase-provided).
--
-- BUCKET IS PRIVATE. No public read. Access ONLY via server-generated signed
-- URLs issued after a tenant/client authorization check (src/lib/brand-assets/).
-- Path convention: "<tenant_id>/<client_id>/<uuid>[.ext]". The policies below
-- re-derive tenant_id (path segment 1) and client_id (segment 2) from the object
-- name and match them against the caller's VERIFIED JWT — INDEPENDENTLY of the
-- brand_assets table's own path CHECK (defense in depth; storage RLS is a
-- distinct isolation surface).
-- ============================================================================

-- 1) The bucket. PRIVATE (public = false). PUT-time gates: MIME allowlist
--    (raster + SVG) and 10 MiB size cap — the first line of defense against a
--    MIME/size bypass on the direct signed-PUT path (the server action re-checks
--    the VERIFIED object metadata on finalize as the second line).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'brand-assets', 'brand-assets', false, 10485760,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2) RLS policies on storage.objects, scoped to THIS bucket only. RLS is already
--    enabled + forced on storage.objects by Supabase; we ADD bucket-scoped
--    policies. Every policy targets `authenticated` only (never anon/public).
--
--    Path-segment authorization (never obscurity alone):
--      segment 1 = tenant_id, segment 2 = client_id.
--    Read : object's tenant segment == caller tenant AND
--           (is_writer  OR  client_viewer whose client_id == segment 2).
--    Write: is_writer AND object's tenant segment == caller tenant
--           (client_viewer is read-only — no write policy matches it).
--
--    Comparisons are TEXT-on-TEXT (JWT claim `->>'tenant_id'` vs the path
--    segment) — deliberately NOT casting the path segment to uuid: a hostile or
--    malformed path must yield a policy MISMATCH (no rows / denied), never a
--    cast error. A path with too few segments makes segment 1/2 NULL, and every
--    comparison against NULL is not-true ⇒ denied (fail closed).

drop policy if exists brand_assets_objects_select on storage.objects;
create policy brand_assets_objects_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'brand-assets'
    and (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id')
    and (
      app.is_writer()
      or (
        app.user_role() = 'client_viewer'
        and (storage.foldername(name))[2] = (auth.jwt() ->> 'client_id')
      )
    )
  );

drop policy if exists brand_assets_objects_insert on storage.objects;
create policy brand_assets_objects_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'brand-assets'
    and app.is_writer()
    and (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id')
  );

drop policy if exists brand_assets_objects_update on storage.objects;
create policy brand_assets_objects_update on storage.objects
  for update to authenticated
  using (
    bucket_id = 'brand-assets'
    and app.is_writer()
    and (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id')
  )
  with check (
    bucket_id = 'brand-assets'
    and app.is_writer()
    and (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id')
  );

drop policy if exists brand_assets_objects_delete on storage.objects;
create policy brand_assets_objects_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'brand-assets'
    and app.is_writer()
    and (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id')
  );

/* ============================ DOWN (manual rollback) ========================
   drop policy if exists brand_assets_objects_select on storage.objects;
   drop policy if exists brand_assets_objects_insert on storage.objects;
   drop policy if exists brand_assets_objects_update on storage.objects;
   drop policy if exists brand_assets_objects_delete on storage.objects;
   -- Only if you intend to destroy every stored object:
   -- delete from storage.objects where bucket_id = 'brand-assets';
   -- delete from storage.buckets where id = 'brand-assets';
============================================================================ */
