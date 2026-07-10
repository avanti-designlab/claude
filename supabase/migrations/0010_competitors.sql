-- ============================================================================
-- 0010_competitors.sql — named competitors per client (share-of-voice: M4
-- reverse-engineering, M19 client dashboard).
--
-- Governed post-freeze change (CLAUDE.md rule 1; BUILD-STATE 2026-07-10 SCOPE
-- AUTHORIZATION item 4). Follows the doc 03 §3/§4 pattern byte-for-byte with the
-- frozen child tables (0003/0005/0006): tenant_id indexed, RLS enabled AND
-- forced, composite-FK tenant-consistency, is_writer write floor, client_viewer
-- own-client read.
--
-- jsonb-on-clients was REJECTED (write-floor mismatch: competitor management is
-- operator work at the is_writer floor, but clients writes are agency_admin
-- only; and both M4 and M19 need queryable rows). The per-client cap (10) is
-- enforced at the write seam in app code — a CHECK cannot count sibling rows —
-- and pinned by a test (src/lib/competitors/actions.test.ts).
-- ============================================================================

create table public.competitors (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete restrict,
  client_id  uuid not null,
  -- The competitor's display name (bounded ≤120). Case-insensitive-unique per
  -- client (index below).
  name       text not null,
  -- Optional bare hostname ("example.com") — no scheme, no path; that grammar
  -- is enforced at the write seam. NULL when only a name is known.
  domain     text,
  created_at timestamptz not null default now(),

  constraint competitors_name_len check (
    char_length(name) >= 1 and char_length(name) <= 120
  ),
  -- Hostnames are ≤253 chars; a generous cap that keeps junk out of the column
  -- (the write seam applies the real bare-hostname grammar).
  constraint competitors_domain_len check (
    domain is null or char_length(domain) <= 253
  ),
  -- Composite-FK anchor + tenant-consistency: a competitor can only belong to a
  -- same-tenant client (structural, not just policy).
  constraint competitors_tenant_id_id_key unique (tenant_id, id),
  constraint competitors_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict
);

-- One competitor NAME per client, case-insensitive — a unique INDEX (a unique
-- CONSTRAINT cannot carry the lower() expression). Leads with tenant_id, so it
-- also satisfies the "tenant_id-leading index everywhere" smoke assertion and
-- serves the (tenant_id, client_id) list read (M19 / M4).
create unique index competitors_client_name_key
  on public.competitors (tenant_id, client_id, lower(name));

comment on table public.competitors is
  'Named competitors per client (M4 share-of-voice, M19 dashboard). Writes at the is_writer floor; per-client cap (10) enforced at the app write seam.';

alter table public.competitors enable row level security;
alter table public.competitors force row level security;

-- Reads: agency staff see the tenant; a client_viewer sees ONLY its own
-- client's competitors (M19 renders share-of-voice) — app.client_scope.
create policy competitors_select on public.competitors
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

create policy competitors_insert on public.competitors
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy competitors_update on public.competitors
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy competitors_delete on public.competitors
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.competitors to authenticated;

/* ============================ DOWN (manual rollback — NOT executed) ==========
   The migration runner executes ONLY the UP above; a devops rollback step runs:

   drop table if exists public.competitors;
============================================================================ */
