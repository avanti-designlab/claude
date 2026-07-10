-- ============================================================================
-- 0009_content_lifecycle_and_title.sql — content_items: title, a STRUCTURAL
-- body-hash verdict binding, the needs_revision send-back state, a strengthened
-- approval gate, and a named human approver.
--
-- Governed post-freeze change (CLAUDE.md rule 1; BUILD-STATE 2026-07-10 SCOPE
-- AUTHORIZATION items 2 + 3). ONE file because every item below alters the SAME
-- content_items CHECK set — independent rollback of the whole content-lifecycle
-- change is the reason for one file per table. Frozen migrations 0001–0008 are
-- untouched.
--
-- doc 03 §3/§6; doc 00 §7.3; CLAUDE.md rules 3 + 5. The review/approval seam is
-- the HUMAN gate: content cannot reach approved/published without BOTH
-- independent gate verdicts recorded, both bound to the exact body+title they
-- reviewed, a humanization pass (for machine prose), AND a named human approver
-- in the row. All enforced structurally — no application code is trusted alone.
--
-- LIVE-DATA NOTE (staging first, per ops/environments.md): the strengthened
-- approval CHECK is added directly (not NOT VALID). This is safe because no
-- verdict-writer exists before this batch — M8 only produces DRAFT rows and
-- nothing writes quality_review/compliance_review — so there are no pre-existing
-- approved/published rows for it to reject. Staging application verifies this.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (a) title — nullable, capped. NO backfill: existing rows stay NULL and the
--     UI renders an honest "Untitled" (never a title fabricated from the body).
-- ----------------------------------------------------------------------------
alter table public.content_items
  add column title text;

alter table public.content_items
  add constraint content_items_title_len
  check (title is null or char_length(title) <= 200);

comment on column public.content_items.title is
  'Optional client-facing headline (≤200). NULL renders as "Untitled" — never fabricated from body. Participates in the body_hash verdict binding.';

-- ----------------------------------------------------------------------------
-- (b) body_hash — a SHA-256 over {title, body}, maintained STRUCTURALLY by a
--     BEFORE INSERT/UPDATE trigger so a buggy write path can never leave a
--     stale hash. The strengthened verdict CHECK (d) binds each recorded verdict
--     to the row's current hash: any body OR title edit changes the hash and
--     structurally invalidates prior verdicts (re-review is required to
--     re-approve). The hash is never settable by a caller — the trigger always
--     overwrites it.
--
--     DIGEST CHOICE — RATIFIED (Orchestrator, 2026-07-10): the built-in
--     pg_catalog.sha256(bytea) (PostgreSQL 11+), NOT pgcrypto's digest(). It is
--     the identical SHA-256 but needs no extension and is callable under
--     `search_path = ''` (pg_catalog is always in scope), so it is portable
--     across the local harness and Supabase without depending on WHICH schema
--     pgcrypto happens to be installed in.
--     BINDING CONDITION of that ratification: THE TRIGGER IS THE SOLE HASH
--     PRODUCER. Application code never recomputes this hash — the verdict
--     actions (src/lib/production/review/actions.ts) copy the row's STORED
--     body_hash exactly as read into each verdict. Any second producer would
--     silently fork the binding; adding one requires the governed path.
--
--     The digest input is jsonb_build_object('title', title, 'body', body)::text
--     — NOT a raw concatenation. JSON canonically and unambiguously separates the
--     two fields (body can never impersonate the field boundary) and
--     distinguishes a NULL title from an empty-string title. Deterministic over
--     its inputs → IMMUTABLE.
-- ----------------------------------------------------------------------------
create function app.content_body_hash(p_body text, p_title text) returns text
language sql immutable
set search_path = ''
as $$
  select encode(
    pg_catalog.sha256(
      convert_to(
        jsonb_build_object('title', p_title, 'body', p_body)::text,
        'UTF8'
      )
    ),
    'hex'
  )
$$;

-- authenticated calls this transitively (the BEFORE trigger runs SECURITY
-- INVOKER as the writer). Mirror the 0001 grant posture: nothing to PUBLIC.
revoke all on function app.content_body_hash(text, text) from public;
grant execute on function app.content_body_hash(text, text) to authenticated;

create function app.content_items_set_body_hash() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.body_hash := app.content_body_hash(new.body, new.title);
  return new;
end
$$;

alter table public.content_items
  add column body_hash text;

-- Backfill via the SAME function the trigger uses (one canonical hash, no
-- divergence) BEFORE the NOT NULL + trigger are in force. On a fresh database
-- this touches zero rows.
update public.content_items
  set body_hash = app.content_body_hash(body, title);

alter table public.content_items
  alter column body_hash set not null;

create trigger content_items_set_body_hash
  before insert or update on public.content_items
  for each row execute function app.content_items_set_body_hash();

comment on column public.content_items.body_hash is
  'SHA-256 over {title, body}, maintained by the content_items_set_body_hash trigger (never caller-set). Recorded into each review verdict; the approval CHECK requires the verdicts'' recorded hash to equal this — so a post-verdict edit invalidates them.';

-- ----------------------------------------------------------------------------
-- (e) approved_by / approved_at — the named human approver (rule 5; the
--     site_changes.approved_by precedent). approved_at is set by the approval
--     ACTION from the server clock, never by a caller.
-- ----------------------------------------------------------------------------
alter table public.content_items
  add column approved_by uuid,
  add column approved_at timestamptz;

-- Audit-trail actor: the approver must be a member of the SAME tenant and its
-- identity survives (RESTRICT — deactivate users, never delete approval
-- history). Composite FK carries tenant_id, exactly like site_changes.
alter table public.content_items
  add constraint content_items_approved_by_fk
  foreign key (tenant_id, approved_by)
  references public.tenant_users (tenant_id, id) on delete restrict;

-- (e) A named human approver is required for any approved/published row.
-- Separate constraint (like site_changes_requires_approval) for a precise
-- error and a targeted test.
alter table public.content_items
  add constraint content_items_approver_present check (
    status not in ('approved', 'published') or approved_by is not null
  );

-- ----------------------------------------------------------------------------
-- (c) status gains EXACTLY ONE new state: needs_revision (the send-back
--     target). draft → in_review → {needs_revision | approved} → published.
-- ----------------------------------------------------------------------------
alter table public.content_items
  drop constraint content_items_status_allowed;
alter table public.content_items
  add constraint content_items_status_allowed check (
    status in ('draft', 'in_review', 'needs_revision', 'approved', 'published')
  );

-- ----------------------------------------------------------------------------
-- (d) STRENGTHENED approval gate — replaces the frozen presence-only
--     content_items_reviewed_before_approval (migration 0005). Same name so the
--     existing "no verdict" rejection tests still resolve to it. Approved or
--     published now requires, ALL structurally:
--       • quality_review.passed    = JSON boolean true (TYPE-STRICT)
--       • compliance_review.passed = JSON boolean true (TYPE-STRICT)
--       • BOTH verdicts recorded the CURRENT body_hash — key PRESENT, string,
--         equal (bound to exactly what each gate reviewed; a post-verdict
--         body/title edit invalidates them)
--       • humanization.passes = JSON boolean true for machine-produced prose
--         (blog | faq | caption | pillar), EXEMPT for schema_copy and for any
--         automation_level = 'human_only' row
--     draft | in_review | needs_revision are unconstrained by this gate.
--     (The named-approver requirement is the separate content_items_approver_present.)
--
--     FAIL-CLOSED CONSTRUCTION (Code Review Blocker remediation + the
--     Orchestrator-directed type tightening, 2026-07-10). A Postgres CHECK
--     passes when its expression is TRUE **or NULL** — so every leg below is
--     built to be TRUE or FALSE, never NULL, and to refuse non-boolean
--     truthiness:
--       • the `is not null` presence conjuncts are two-valued; a missing
--         verdict/humanization column collapses the whole AND to FALSE
--         (FALSE AND NULL = FALSE, independent of evaluation order);
--       • jsonb CONTAINMENT (`@>`) over non-null operands is two-valued and
--         TYPE-EXACT — it is the directed "jsonb_typeof(...) = 'boolean' and
--         true" requirement expressed as one total operator: `passed`/`passes`
--         must be the JSON boolean true (string "true"/"t"/"1"/"yes", number
--         1, and JSON null all fail), and `body_hash` must be PRESENT and
--         equal to the row's body_hash (an OMITTED key or JSON null yields
--         FALSE, never NULL — an absent hash is not a bound hash);
--       • no `::boolean` text-cast anywhere: casts accept truthy strings, can
--         raise errors on junk values, and SQL guarantees no AND
--         short-circuit ORDER inside a CHECK — containment cannot error or go
--         NULL on any jsonb shape.
--     body_hash is NOT NULL (above), so jsonb_build_object never embeds a JSON
--     null on the containment's right-hand side.
-- ----------------------------------------------------------------------------
alter table public.content_items
  drop constraint content_items_reviewed_before_approval;

alter table public.content_items
  add constraint content_items_reviewed_before_approval check (
    status in ('draft', 'in_review', 'needs_revision')
    or (
      quality_review is not null
      and compliance_review is not null
      and quality_review @> jsonb_build_object('passed', true, 'body_hash', body_hash)
      and compliance_review @> jsonb_build_object('passed', true, 'body_hash', body_hash)
      and (
        type = 'schema_copy'
        or automation_level = 'human_only'
        or (
          humanization is not null
          and humanization @> '{"passes": true}'::jsonb
        )
      )
    )
  );

/* ============================ DOWN (manual rollback — NOT executed) ==========
   Reverses 0009 cleanly to the frozen 0005 shape. This block is a SQL comment:
   the migration runner executes ONLY the UP above. A devops rollback step runs
   the statements below. It ASSUMES no rows are currently in status
   'needs_revision' and no approved/published row depends on the strengthened
   gate (true whenever the review actions have not yet produced such rows);
   otherwise reconcile that data first.

   drop trigger if exists content_items_set_body_hash on public.content_items;

   alter table public.content_items
     drop constraint if exists content_items_reviewed_before_approval;
   alter table public.content_items
     add constraint content_items_reviewed_before_approval check (
       status in ('draft', 'in_review')
       or (quality_review is not null and compliance_review is not null)
     );

   alter table public.content_items
     drop constraint if exists content_items_status_allowed;
   alter table public.content_items
     add constraint content_items_status_allowed check (
       status in ('draft', 'in_review', 'approved', 'published')
     );

   alter table public.content_items
     drop constraint if exists content_items_approver_present;
   alter table public.content_items
     drop constraint if exists content_items_approved_by_fk;
   alter table public.content_items
     drop constraint if exists content_items_title_len;
   alter table public.content_items
     drop column if exists approved_at,
     drop column if exists approved_by,
     drop column if exists body_hash,
     drop column if exists title;

   drop function if exists app.content_items_set_body_hash();
   drop function if exists app.content_body_hash(text, text);
============================================================================ */
