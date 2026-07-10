-- ============================================================================
-- 0011_runs.sql — the read-only scan work-order queue (the state store for the
-- ratified runs-queue architecture: BUILD-STATE 2026-07-10 ARCHITECTURE RULING).
--
-- Governed post-freeze change (CLAUDE.md rule 1). THIS MIGRATION IS THE TABLE
-- ONLY. The processor / SECURITY DEFINER lease_next_run() / sweeper are a
-- SEPARATELY-GATED block (ruling A8: Code Review + a QA adversarial
-- concurrency/recovery suite) and are NOT built here. Follows the doc 03 §3/§4
-- pattern and the ruling's A4 schema conditions.
--
-- SCOPE INVARIANT (ruling): a runs row is a READ-ONLY scan work-order. It must
-- NEVER vehicle a client-site write — writes stay behind change-management
-- (site_changes, rule 4). Nothing here references or enables a write path.
--
-- The legal status transitions (queued → running → succeeded|failed;
-- queued → canceled; running → failed by the sweeper only; retry re-queues the
-- SAME row with attempts+1 to a cap; an operator re-run is a NEW row; terminal
-- states are immutable) are enforced by the future queue ACTIONS and pinned by
-- src/lib/runs/transitions.ts + its test — the DB stores the states honestly;
-- the transition graph is app-logic.
-- ============================================================================

create table public.runs (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete restrict,
  client_id    uuid not null,
  -- Property-scoped kinds (audit, monitor, decay, local) carry a property_id;
  -- client-scoped kinds (visibility, entity) leave it NULL. The composite FK is
  -- enforced only when non-null (MATCH SIMPLE).
  property_id  uuid,
  kind         text not null,
  status       text not null default 'queued',
  attempts     int  not null default 0,
  -- Bounded + CONTENT-FREE by convention (a small progress frontier such as
  -- {crawled, total, phase}) — NEVER crawled URLs or page content (honesty rule;
  -- error_code carries the only failure signal).
  progress     jsonb not null default '{}'::jsonb,
  heartbeat_at timestamptz,
  -- The operator who enqueued the run; NULL for system/sweeper re-queues.
  -- Transient work-order actor: SET NULL on user removal keeps the run history
  -- while dropping attribution (NOT the site_changes audit trail, which
  -- RESTRICTs).
  requested_by uuid,
  -- CONTENT-FREE pointer to the produced artifact (e.g. {"kind":"audit",
  -- "id":"<uuid>"}); NULL until a run succeeds. Concrete shape is ratified with
  -- the processor block — never raw output.
  result_ref   jsonb,
  -- CLOSED enum — NEVER raw error text or URLs. Set only on a failed run. Each
  -- value matches ^[a-z_]{1,32}$.
  error_code   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint runs_kind_allowed check (
    kind in ('audit', 'monitor', 'decay', 'local', 'entity', 'visibility')
  ),
  constraint runs_status_allowed check (
    status in ('queued', 'running', 'succeeded', 'failed', 'canceled')
  ),
  constraint runs_attempts_nonneg check (attempts >= 0),
  constraint runs_progress_is_object check (jsonb_typeof(progress) = 'object'),
  constraint runs_result_ref_is_object check (
    result_ref is null or jsonb_typeof(result_ref) = 'object'
  ),
  constraint runs_error_code_allowed check (
    error_code is null or error_code in (
      'crawl_refused', 'budget_exhausted_total', 'engine_error',
      'orphaned', 'misconfigured'
    )
  ),
  -- An error_code is meaningful ONLY on a failed run: no failure signal may hide
  -- on a queued/running/succeeded/canceled row.
  constraint runs_error_code_only_on_failed check (
    error_code is null or status = 'failed'
  ),
  -- Composite-FK anchors + tenant-consistency (doc 03 §4 strategy).
  constraint runs_tenant_id_id_key unique (tenant_id, id),
  constraint runs_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict,
  -- Property-scoped runs reference the property via its (tenant_id, client_id,
  -- id) anchor — the target property must be the SAME tenant AND client.
  constraint runs_property_fk foreign key (tenant_id, client_id, property_id)
    references public.properties (tenant_id, client_id, id) on delete restrict,
  constraint runs_requested_by_fk foreign key (tenant_id, requested_by)
    references public.tenant_users (tenant_id, id) on delete set null (requested_by)
);

-- tenant_id-leading history index (also satisfies the smoke "tenant_id-leading
-- index everywhere" assertion). The cross-tenant lease index
-- (FOR UPDATE SKIP LOCKED support) lands WITH lease_next_run() in the
-- separately-gated queue-infra block, not here.
create index runs_client_created_idx
  on public.runs (tenant_id, client_id, created_at desc);

comment on table public.runs is
  'Read-only scan work-order queue (ARCHITECTURE RULING 2026-07-10). Table only — processor/lease/sweeper are the separately-gated queue-infra block. A runs row never vehicles a client-site write.';

create trigger set_updated_at
  before update on public.runs
  for each row execute function app.set_updated_at();

alter table public.runs enable row level security;
alter table public.runs force row level security;

-- Runs are the INTERNAL scan work-order queue (operator surface). SELECT is
-- WRITER-ONLY — RATIFIED (Orchestrator, 2026-07-10): client_viewer is
-- intentionally EXCLUDED — the client dashboard reads finished artifacts
-- (audits, visibility_results, metrics), not the raw queue. runs carries
-- client_id for tenant-consistency + client filtering, like tenant_users
-- carries it without being a client_viewer surface. This is MORE restrictive
-- than the app.client_scope default and cannot leak. Widening to
-- app.client_scope (if the client dashboard must ever render run state)
-- requires the governed post-freeze path.
--
-- The processor's cross-tenant lease runs under service_role / a reviewed
-- SECURITY DEFINER (ruling A1) and bypasses these policies by design; these
-- govern only the app-facing (per-tenant) surface. The is_writer INSERT policy
-- is the enqueue floor.
create policy runs_select on public.runs
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

create policy runs_insert on public.runs
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy runs_update on public.runs
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy runs_delete on public.runs
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.runs to authenticated;

/* ============================ DOWN (manual rollback — NOT executed) ==========
   The migration runner executes ONLY the UP above; a devops rollback step runs:

   drop table if exists public.runs;
============================================================================ */
