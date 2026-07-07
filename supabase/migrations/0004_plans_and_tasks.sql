-- ============================================================================
-- 0004_plans_and_tasks.sql — playbook binding + generated plan + tasks
-- (doc 03 §3, §6).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- PLANS
-- ----------------------------------------------------------------------------

create table public.plans (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete restrict,
  client_id         uuid not null,
  playbook_version  text not null,
  -- Prioritized tasks from Playbook Engine + audit (doc 03 §3).
  generated_roadmap jsonb not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Composite-FK anchors. The three-column anchor lets tasks prove that their
  -- plan belongs to the SAME client (not just the same tenant).
  constraint plans_tenant_id_id_key unique (tenant_id, id),
  constraint plans_tenant_client_id_key unique (tenant_id, client_id, id),
  constraint plans_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict
);

create trigger set_updated_at
  before update on public.plans
  for each row execute function app.set_updated_at();

alter table public.plans enable row level security;
alter table public.plans force row level security;

create policy plans_select on public.plans
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

create policy plans_insert on public.plans
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy plans_update on public.plans
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy plans_delete on public.plans
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.plans to authenticated;

-- ----------------------------------------------------------------------------
-- TASKS
-- ----------------------------------------------------------------------------

create table public.tasks (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete restrict,
  client_id        uuid not null,
  plan_id          uuid not null,
  -- Which module (audit/content/schema/local/...) — open set per doc 03 §3.
  module           text not null,
  -- doc 03 §6: auto | ai_draft_human_approve | human_only. Default is the
  -- "anything that publishes" level — fail toward human review.
  automation_level text not null default 'ai_draft_human_approve',
  status           text not null default 'todo',
  assigned_to      uuid,
  payload          jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint tasks_automation_level_allowed check (
    automation_level in ('auto', 'ai_draft_human_approve', 'human_only')
  ),
  constraint tasks_status_allowed check (
    status in ('todo', 'in_progress', 'in_review', 'approved', 'published', 'reverted')
  ),
  -- Tenant-consistency: the plan must belong to the same tenant AND the same
  -- client as the task.
  constraint tasks_plan_fk foreign key (tenant_id, client_id, plan_id)
    references public.plans (tenant_id, client_id, id) on delete restrict,
  -- Assignee must be a member of the same tenant; unassign on user removal
  -- (column-targeted SET NULL keeps tenant_id intact).
  constraint tasks_assigned_to_fk foreign key (tenant_id, assigned_to)
    references public.tenant_users (tenant_id, id) on delete set null (assigned_to)
);

comment on column public.tasks.automation_level is
  'doc 03 §6: auto (no human) | ai_draft_human_approve (default for anything that publishes) | human_only.';

create index tasks_plan_status_idx on public.tasks (tenant_id, plan_id, status);
create index tasks_client_status_idx on public.tasks (tenant_id, client_id, status);
create index tasks_assigned_to_idx on public.tasks (tenant_id, assigned_to)
  where assigned_to is not null;

create trigger set_updated_at
  before update on public.tasks
  for each row execute function app.set_updated_at();

alter table public.tasks enable row level security;
alter table public.tasks force row level security;

create policy tasks_select on public.tasks
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy tasks_update on public.tasks
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy tasks_delete on public.tasks
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.tasks to authenticated;
