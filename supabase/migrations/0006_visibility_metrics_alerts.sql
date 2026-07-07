-- ============================================================================
-- 0006_visibility_metrics_alerts.sql — visibility/metrics telemetry + alerts
-- (doc 03 §3).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- VISIBILITY_RESULTS — append-only engine-citation captures (history matters —
-- churn is high; the hot read path is per-client per-engine history)
-- ----------------------------------------------------------------------------

create table public.visibility_results (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete restrict,
  client_id    uuid not null,
  engine       text not null,
  prompt       text not null,
  cited        boolean not null,
  position     int,
  sentiment    text,
  -- What was cited instead — feeds M4 competitor reverse-engineering.
  cited_source text,
  captured_at  timestamptz not null default now(),

  constraint visibility_results_engine_allowed check (
    engine in ('chatgpt', 'perplexity', 'gemini', 'claude', 'copilot', 'google_aio')
  ),
  constraint visibility_results_position_positive check (
    position is null or position >= 1
  ),
  constraint visibility_results_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict
);

create index visibility_results_history_idx
  on public.visibility_results (tenant_id, client_id, engine, captured_at desc);

alter table public.visibility_results enable row level security;
alter table public.visibility_results force row level security;

create policy visibility_results_select on public.visibility_results
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

create policy visibility_results_insert on public.visibility_results
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy visibility_results_update on public.visibility_results
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy visibility_results_delete on public.visibility_results
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.visibility_results to authenticated;

-- ----------------------------------------------------------------------------
-- METRICS — external measurement captures (GSC/GA4/call-tracking/local/reviews)
-- ----------------------------------------------------------------------------

create table public.metrics (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete restrict,
  client_id   uuid not null,
  source      text not null,
  data        jsonb not null,
  captured_at timestamptz not null default now(),

  constraint metrics_source_allowed check (
    source in ('gsc', 'ga4', 'call_tracking', 'local_rank', 'reviews')
  ),
  constraint metrics_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict
);

create index metrics_history_idx
  on public.metrics (tenant_id, client_id, source, captured_at desc);

alter table public.metrics enable row level security;
alter table public.metrics force row level security;

create policy metrics_select on public.metrics
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

create policy metrics_insert on public.metrics
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy metrics_update on public.metrics
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy metrics_delete on public.metrics
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.metrics to authenticated;

-- ----------------------------------------------------------------------------
-- ALERTS — M17 alerting engine
-- ----------------------------------------------------------------------------

create table public.alerts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete restrict,
  client_id    uuid not null,
  type         text not null,
  severity     text not null,
  payload      jsonb not null default '{}'::jsonb,
  acknowledged boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- doc 03 §3 lists six types; doc 07 §1.8 (M17) adds auto-rollback fired —
  -- the superset is used (contracts doc §9).
  constraint alerts_type_allowed check (
    type in (
      'visibility_drop', 'competitor_overtook', 'schema_broke',
      'crawler_blocked', 'negative_review_spike', 'site_down',
      'auto_rollback_fired'
    )
  ),
  -- Severity value set is doc-silent — chosen at F1, flagged for ratification
  -- (contracts doc §9).
  constraint alerts_severity_allowed check (
    severity in ('info', 'warning', 'critical')
  ),
  constraint alerts_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict
);

create index alerts_client_created_idx
  on public.alerts (tenant_id, client_id, created_at desc);
create index alerts_unacknowledged_idx
  on public.alerts (tenant_id, created_at desc)
  where not acknowledged;

create trigger set_updated_at
  before update on public.alerts
  for each row execute function app.set_updated_at();

alter table public.alerts enable row level security;
alter table public.alerts force row level security;

create policy alerts_select on public.alerts
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

create policy alerts_insert on public.alerts
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy alerts_update on public.alerts
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy alerts_delete on public.alerts
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.alerts to authenticated;
