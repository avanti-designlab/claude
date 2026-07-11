-- ============================================================================
-- 0015_brand_extract_drafts.sql — the `brand_extract` scan kind: its persisted
-- artifact (`brand_extract_drafts`) + the two additive `runs` extensions that
-- make the kind executable through the SAME queue as `audit`.
--
-- Governed post-freeze change (CLAUDE.md rule 1), authorized by the Orchestrator
-- ruling recorded in docs/BUILD-STATE.md ("the brand_extract scan kind" slice).
-- Migrations 0001–0014 are FROZEN and BYTE-UNTOUCHED; this migration only ADDS
-- (a new kind value, a new nullable column + its CHECKs, a new table). It adds
-- NO function — the closed set lease_next_run / reap_orphaned_runs /
-- requeue_failed_runs (0012) is unchanged (ruling condition 5), and
-- lease_next_run `returns public.runs`, so the new column flows through the lease
-- automatically with zero change to that function.
--
-- WHY brand_extract carries an input_url (and audits do not):
--   An `audit` run reads its target from a STORED property (run.property_id →
--   properties.url). A `brand_extract` run analyzes an operator-PASTED URL for a
--   client that may be PRE-ONBOARDING (no property row yet) — so the target has
--   no property home. The produced draft is OUTPUT (the adapter writes it on
--   success), so the input URL cannot live on the draft either; it must ride the
--   run row between enqueue and lease. `runs.input_url` is that carrier. It is
--   the operator's own request parameter (the property.url analog), NOT crawled
--   content — so it does not belong in the content-free `progress` frontier.
--   The URL is a SHAPE-checked-at-enqueue value; the REAL SSRF defense is the
--   adapter's per-fetch egress guard + socket pin (src/lib/runs/adapters/
--   brand-extract.ts), never this column.
--
-- SCOPE INVARIANT (0011 header, still holds): a runs row is a READ-ONLY scan
-- work-order. brand_extract reads a site and proposes a DRAFT kit for human
-- review — it NEVER writes a client site. The draft only PREFILLS the M7 ingest
-- form later; every value is re-validated through resolveAndValidateTokens at
-- the existing review→lock, so the untrusted extracted `draft` jsonb is never a
-- CSS-injection path (it is data here, never emitted).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) runs.kind gains 'brand_extract' (additive — drop + re-add the CHECK; the
--     six existing kinds are preserved verbatim, order-independent).
-- ----------------------------------------------------------------------------
alter table public.runs drop constraint runs_kind_allowed;
alter table public.runs add constraint runs_kind_allowed check (
  kind in ('audit', 'monitor', 'decay', 'local', 'entity', 'visibility', 'brand_extract')
);

-- ----------------------------------------------------------------------------
-- (2) runs.input_url — the brand_extract target carrier (see header). Nullable;
--     present IFF the run is a brand_extract. Bounded (mirrors
--     BRAND_EXTRACT_INPUT_URL_MAX_CHARS in src/lib/runs/config.ts, ⚑ ratify).
--     Existing rows (kind<>'brand_extract', input_url NULL) satisfy the coupling
--     CHECK: (false) = (false) — so this validates cleanly against live data.
-- ----------------------------------------------------------------------------
alter table public.runs add column input_url text;
alter table public.runs add constraint runs_input_url_len check (
  input_url is null or char_length(input_url) between 1 and 2048
);
-- Only a brand_extract run carries a target URL, and a brand_extract run must:
-- audits/monitors/etc. read a stored property, never a pasted URL.
alter table public.runs add constraint runs_input_url_only_brand_extract check (
  (kind = 'brand_extract') = (input_url is not null)
);

comment on column public.runs.input_url is
  'brand_extract ONLY: the operator-pasted target URL (property.url analog for a pre-onboarding client). NOT crawled content — never goes in the content-free progress frontier. SHAPE-checked at enqueue; the real SSRF defense is the adapter''s per-fetch egress guard + socket pin.';

-- ----------------------------------------------------------------------------
-- (3) brand_extract_drafts — the persisted proposed brand kit (doc 03 §3/§4;
--     mirrors runs 0011 / brand_assets 0014): tenant_id + client_id, RLS ENABLED
--     and FORCED, composite FK (tenant_id, client_id) → clients, tenant_id-
--     leading index. Client-scoped (a draft belongs to a client row, even pre-
--     onboarding — never gated on a stored property).
-- ----------------------------------------------------------------------------
create table public.brand_extract_drafts (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete restrict,
  client_id   uuid not null,
  -- The brand_extract run that produced this draft. SET NULL if the transient
  -- work-order row is ever pruned — the DRAFT (the valuable artifact) survives,
  -- only the provenance link drops (mirrors runs.requested_by's SET NULL shape).
  run_id      uuid,
  -- The deterministic BrandKitDraft (colors/typography/logoUrl/voice/notes) PLUS
  -- capped logo/imagery candidate URL lists — see the adapter's caps (⚑ set in
  -- src/lib/runs/config.ts: each URL length-capped, each list count-capped). This
  -- is UNTRUSTED extracted input: it PREFILLS the ingest form, and every value is
  -- re-validated through resolveAndValidateTokens at review→lock — never emitted
  -- into CSS here. NO source_text is persisted (ruled: not stored in v1).
  draft       jsonb not null,
  status      text not null default 'proposed',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint brand_extract_drafts_status_allowed check (
    status in ('proposed', 'consumed', 'discarded')
  ),
  constraint brand_extract_drafts_draft_is_object check (jsonb_typeof(draft) = 'object'),
  -- Bounded serialized jsonb — the structural backstop under the adapter's caps
  -- (mirrors BRAND_EXTRACT_DRAFT_MAX_CHARS in src/lib/runs/config.ts). A valid
  -- draft (4 colors + 3 stacks + 1 logo + ≤8 logo + ≤8 imagery capped URLs +
  -- notes) sits well under this; the cap is the last line, never the shaper.
  constraint brand_extract_drafts_draft_bounded check (char_length(draft::text) <= 65536),
  -- Composite-FK anchors + tenant-consistency (doc 03 §4 strategy).
  constraint brand_extract_drafts_tenant_id_id_key unique (tenant_id, id),
  constraint brand_extract_drafts_client_fk foreign key (tenant_id, client_id)
    references public.clients (tenant_id, id) on delete restrict,
  -- run_id anchored to the run's (tenant_id, id) unique key; SET NULL keeps the
  -- draft if the run is deleted (MATCH SIMPLE: a null run_id is not enforced).
  constraint brand_extract_drafts_run_fk foreign key (tenant_id, run_id)
    references public.runs (tenant_id, id) on delete set null (run_id)
);

comment on table public.brand_extract_drafts is
  'Persisted brand_extract artifact (Orchestrator ruling). A client-scoped, human-reviewed DRAFT brand kit proposed from a pasted URL. status proposed|consumed|discarded; NEVER two live (proposed) drafts per client (brand_extract_drafts_one_proposed_idx). The draft jsonb is untrusted extracted input — it prefills the M7 ingest form and is re-validated at review→lock, never emitted into CSS.';

-- NEVER two live drafts for one client — the STRUCTURAL guarantee behind the
-- supersede rider (a partial unique index over the single live status). A second
-- concurrent completion's insert collides here (→ the adapter's engine_error →
-- retry, which re-supersedes and converges to newest-wins). Enqueue-time and
-- adapter-time supersede (proposed → discarded) keep the common paths clean; this
-- index makes the invariant impossible to violate.
create unique index brand_extract_drafts_one_proposed_idx
  on public.brand_extract_drafts (tenant_id, client_id)
  where status = 'proposed';

-- tenant_id-leading history index (per-client, newest first) — also satisfies the
-- smoke "tenant_id-leading index everywhere" assertion.
create index brand_extract_drafts_client_created_idx
  on public.brand_extract_drafts (tenant_id, client_id, created_at desc);

create trigger set_updated_at
  before update on public.brand_extract_drafts
  for each row execute function app.set_updated_at();

alter table public.brand_extract_drafts enable row level security;
alter table public.brand_extract_drafts force row level security;

-- WRITER-ONLY, like `runs` (0011): a brand_extract draft is INTERNAL pre-approval
-- operator material (an unreviewed proposal), NOT a client-facing artifact.
-- client_viewer is intentionally EXCLUDED (more restrictive than app.client_scope
-- and it cannot leak). The processor persists the draft through the per-run RLS-
-- scoped client (is_writer), NOT service_role.
create policy brand_extract_drafts_select on public.brand_extract_drafts
  for select to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

create policy brand_extract_drafts_insert on public.brand_extract_drafts
  for insert to authenticated
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy brand_extract_drafts_update on public.brand_extract_drafts
  for update to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer())
  with check (tenant_id = app.tenant_id() and app.is_writer());

create policy brand_extract_drafts_delete on public.brand_extract_drafts
  for delete to authenticated
  using (tenant_id = app.tenant_id() and app.is_writer());

grant select, insert, update, delete on public.brand_extract_drafts to authenticated;

/* ============================ DOWN (manual rollback — NOT executed) ==========
   The migration runner executes ONLY the UP above; a devops rollback step runs:

   drop table if exists public.brand_extract_drafts;
   alter table public.runs drop constraint if exists runs_input_url_only_brand_extract;
   alter table public.runs drop constraint if exists runs_input_url_len;
   alter table public.runs drop column if exists input_url;
   alter table public.runs drop constraint runs_kind_allowed;
   alter table public.runs add constraint runs_kind_allowed check (
     kind in ('audit', 'monitor', 'decay', 'local', 'entity', 'visibility'));

   (A lingering brand_extract run would make the kind-CHECK restore abort LOUDLY,
   never silently strand — reconcile those rows first.)
============================================================================ */
