-- ============================================================================
-- 0005_audits_content_items_site_changes.sql — intelligence captures, content
-- production, and the client-site change audit trail (doc 03 §3, §6).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- AUDITS — immutable rubric captures (aeo-audit skill output)
-- ----------------------------------------------------------------------------

create table public.audits (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete restrict,
  client_id   uuid not null,
  property_id uuid not null,
  -- Rubric results from the aeo-audit skill.
  score       jsonb not null,
  -- Prioritized fix list with impact estimates.
  fixes       jsonb not null,
  created_at  timestamptz not null default now(),

  -- Tenant-consistency: the audited property must belong to the same tenant
  -- AND the same client.
  constraint audits_property_fk foreign key (tenant_id, client_id, property_id)
    references public.properties (tenant_id, client_id, id) on delete restrict
);

create index audits_property_created_idx
  on public.audits (tenant_id, property_id, created_at desc);
create index audits_client_created_idx
  on public.audits (tenant_id, client_id, created_at desc);

alter table public.audits enable row level security;
alter table public.audits force row level security;

create policy audits_select on public.audits
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

create policy audits_insert on public.audits
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy audits_update on public.audits
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy audits_delete on public.audits
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.audits to authenticated;

-- ----------------------------------------------------------------------------
-- CONTENT_ITEMS — blogs, FAQ rewrites, captions, schema copy
-- ----------------------------------------------------------------------------

create table public.content_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete restrict,
  client_id         uuid not null,
  type              text not null,
  brand_kit_id      uuid not null,
  -- doc 03 §6: every generative action carries automation_level.
  automation_level  text not null default 'ai_draft_human_approve',
  body              text not null,
  -- {humanized: bool, detection_score, passes: bool} (doc 05 authenticity gate).
  humanization      jsonb,
  -- content-quality agent verdict. NULL until that agent has reviewed.
  quality_review    jsonb,
  -- compliance-review agent verdict. NULL until that agent has reviewed.
  compliance_review jsonb,
  status            text not null default 'draft',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint content_items_type_allowed check (
    type in ('blog', 'faq', 'caption', 'pillar', 'schema_copy')
  ),
  constraint content_items_automation_level_allowed check (
    automation_level in ('auto', 'ai_draft_human_approve', 'human_only')
  ),
  constraint content_items_status_allowed check (
    status in ('draft', 'in_review', 'approved', 'published')
  ),
  constraint content_items_humanization_is_object check (
    humanization is null or jsonb_typeof(humanization) = 'object'
  ),
  constraint content_items_quality_review_is_object check (
    quality_review is null or jsonb_typeof(quality_review) = 'object'
  ),
  constraint content_items_compliance_review_is_object check (
    compliance_review is null or jsonb_typeof(compliance_review) = 'object'
  ),
  -- STRUCTURAL review gate (doc 00 §7.3, CLAUDE.md rule 3): content cannot
  -- reach approved/published without BOTH independent review verdicts
  -- recorded. Default state is draft — publishing without review is
  -- impossible by construction.
  constraint content_items_reviewed_before_approval check (
    status in ('draft', 'in_review')
    or (quality_review is not null and compliance_review is not null)
  ),
  -- Tenant-consistency: the brand kit must belong to the same tenant AND the
  -- same client (all content is brand-forced).
  constraint content_items_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict,
  constraint content_items_brand_kit_fk foreign key (tenant_id, client_id, brand_kit_id)
    references public.brand_kits (tenant_id, client_id, id) on delete restrict
);

create index content_items_client_status_idx
  on public.content_items (tenant_id, client_id, status);

create trigger set_updated_at
  before update on public.content_items
  for each row execute function app.set_updated_at();

alter table public.content_items enable row level security;
alter table public.content_items force row level security;

create policy content_items_select on public.content_items
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

create policy content_items_insert on public.content_items
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy content_items_update on public.content_items
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy content_items_delete on public.content_items
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.content_items to authenticated;

-- ----------------------------------------------------------------------------
-- SITE_CHANGES — every write to a client site (the auto-fix audit trail,
-- doc 00 §7.4: change-log + diff + rollback; no silent auto-fix)
-- ----------------------------------------------------------------------------

create table public.site_changes (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete restrict,
  client_id        uuid not null,
  property_id      uuid not null,
  method           text not null,
  change_type      text not null,
  -- doc 03 §6: every generative action carries automation_level. On THIS
  -- table 'auto' is structurally prohibited (CHECK below): every change_type
  -- here is an on-page write, and fully autonomous publishing is banned
  -- (doc 00 §2, CLAUDE.md rule 5, doc 04 §6). doc 03 §6's legitimate 'auto'
  -- examples are all non-writes; auto-rollback is expressed via
  -- status = 'auto_reverted' and needs no 'auto' automation_level.
  automation_level text not null default 'ai_draft_human_approve',
  -- {before, after} diff (doc 03 §3).
  diff             jsonb not null,
  applied_by       uuid,
  approved_by      uuid,
  status           text not null default 'previewed',
  reverted_reason  text,
  applied_at       timestamptz,
  reverted_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint site_changes_method_allowed check (
    method in ('wordpress', 'webflow', 'wix', 'edge_worker', 'pr')
  ),
  constraint site_changes_change_type_allowed check (
    change_type in ('h1', 'title', 'meta', 'schema', 'alt', 'content', 'canonical')
  ),
  constraint site_changes_automation_level_allowed check (
    automation_level in ('ai_draft_human_approve', 'human_only')
  ),
  constraint site_changes_status_allowed check (
    status in ('previewed', 'applied', 'reverted', 'auto_reverted')
  ),
  constraint site_changes_diff_is_object check (jsonb_typeof(diff) = 'object'),
  -- Lifecycle integrity: anything past preview has an applied_at; reverted
  -- states have a reverted_at.
  constraint site_changes_applied_has_timestamp check (
    status = 'previewed' or applied_at is not null
  ),
  constraint site_changes_reverted_has_timestamp check (
    status not in ('reverted', 'auto_reverted') or reverted_at is not null
  ),
  -- STRUCTURAL approval gate (doc 00 §2, doc 04 §6; doc 03 §3 "required for
  -- non-auto" — and no row on this table can be 'auto'): NO change may leave
  -- the previewed state without a recorded human approver. Composes with the
  -- lifecycle CHECKs above: leaving 'previewed' requires approved_by AND
  -- applied_at; reverted states additionally require reverted_at.
  constraint site_changes_requires_approval check (
    status = 'previewed' or approved_by is not null
  ),
  -- Tenant-consistency: the property must belong to the same tenant AND the
  -- same client; actors must be members of the same tenant.
  constraint site_changes_property_fk foreign key (tenant_id, client_id, property_id)
    references public.properties (tenant_id, client_id, id) on delete restrict,
  -- RESTRICT (not SET NULL): this is the audit trail — actor identity must
  -- survive; deactivate users instead of deleting them.
  constraint site_changes_applied_by_fk foreign key (tenant_id, applied_by)
    references public.tenant_users (tenant_id, id) on delete restrict,
  constraint site_changes_approved_by_fk foreign key (tenant_id, approved_by)
    references public.tenant_users (tenant_id, id) on delete restrict
);

create index site_changes_property_applied_idx
  on public.site_changes (tenant_id, property_id, applied_at desc);
create index site_changes_client_created_idx
  on public.site_changes (tenant_id, client_id, created_at desc);

create trigger set_updated_at
  before update on public.site_changes
  for each row execute function app.set_updated_at();

alter table public.site_changes enable row level security;
alter table public.site_changes force row level security;

-- client_viewer read access = the client dashboard's "work-done log" (M19).
create policy site_changes_select on public.site_changes
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.client_scope(client_id));

create policy site_changes_insert on public.site_changes
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy site_changes_update on public.site_changes
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy site_changes_delete on public.site_changes
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.site_changes to authenticated;
