-- ============================================================================
-- 0016_input_url_immutable.sql — `runs.input_url` joins the transition guard's
-- identity-immutability set: the recorded brand_extract target becomes
-- immutable post-enqueue AT THE DATABASE, on the tenant path and the
-- privileged path alike.
--
-- Governed post-freeze change (CLAUDE.md rule 1) — Orchestrator ruling
-- (2026-07-11, the brand_extract slice follow-up): Orchestrator sign-off GIVEN;
-- Code Review completes the dual post-freeze sign-off on this migration.
--
-- THE GAP THIS CLOSES: migration 0015 added `runs.input_url` — the pasted URL
-- for the `brand_extract` run kind, framed in 0015's own header as "the
-- operator's own request parameter (the property.url analog)". But the 0012
-- `app.runs_transition_guard()` BEFORE UPDATE trigger's identity-immutability
-- set (id / tenant_id / client_id / kind / property_id / requested_by /
-- created_at) was NOT extended — so a same-tenant writer could UPDATE
-- input_url on a queued/running run, making the run row's recorded target
-- (the audit record the operator sees) mutable post-enqueue.
--
-- NOT a security/SSRF fix — both gates agreed there is no such exposure: RLS
-- confines the write to the writer's own tenant; the adapter re-guards EVERY
-- fetch via the pre-DNS egress check + socket-pinned resolve-vet regardless of
-- what input_url says (src/lib/runs/adapters/brand-extract.ts); and the 0015
-- coupling + length CHECKs still fire on UPDATE. The Orchestrator ruled on
-- INTEGRITY grounds: the run row is an audit record in a system whose
-- change-management identity is "every change logged, diffable, reversible" —
-- a mutable input_url permits a record whose displayed target can disagree
-- with what was actually fetched (a PRE-lease mutation rewrites what gets
-- fetched after enqueue; a POST-lease mutation changes only the display).
-- Ruling: extend the guard NOW (option B).
--
-- WHAT THIS MIGRATION IS: exactly one CREATE OR REPLACE of
-- app.runs_transition_guard() — the COMPLETE 0012 definition with EXACTLY ONE
-- addition to EACH of its two identity blocks (privileged path and tenant
-- path): `new.input_url is distinct from old.input_url` joins the refused set.
-- Same error texts, same edges, same carve-outs — byte-identical otherwise.
-- The closed 3-function set (lease_next_run / reap_orphaned_runs /
-- requeue_failed_runs, 0012) is UNTOUCHED: none of them writes input_url, so
-- every legal queue op passes the extended check unchanged. The trigger
-- binding, the function's ACL (revoked from PUBLIC in 0012), and its catalog
-- comment all survive CREATE OR REPLACE.
--
-- WHY A NEW MIGRATION: applied migrations are NEVER edited in place — 0012
-- cannot be amended and re-run. Migrations 0001–0015 are byte-untouched; this
-- file replaces one function body and does nothing else.
-- ============================================================================

create or replace function app.runs_transition_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_op       text;
  v_owner    name;
  v_is_owner boolean;
  -- STRUCTURAL retry cap — mirrors RETRY_ATTEMPT_CAP (see header).
  c_attempt_cap constant int := 3;
begin
  v_op := nullif(pg_catalog.current_setting('app.runs_queue_op', true), '');
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner
  from pg_catalog.pg_class c where c.oid = tg_relid;
  v_is_owner := (current_user = v_owner);

  if v_op is not null then
    -- PRIVILEGED PATH: requires the definer execution context too (threat
    -- reasoning in the header — a GUC set by a non-owner is a spoof attempt).
    if not v_is_owner then
      raise exception 'runs_transition_refused: privileged queue op outside definer context';
    end if;

    -- Identity is immutable on privileged edges as well.
    if new.id is distinct from old.id
       or new.tenant_id is distinct from old.tenant_id
       or new.client_id is distinct from old.client_id
       or new.kind is distinct from old.kind
       or new.property_id is distinct from old.property_id
       or new.input_url is distinct from old.input_url
       or new.requested_by is distinct from old.requested_by
       or new.created_at is distinct from old.created_at then
      raise exception 'runs_transition_refused: row identity is immutable';
    end if;

    if v_op = 'lease' then
      if not (old.status = 'queued' and new.status = 'running') then
        raise exception 'runs_transition_refused: lease may only do queued->running';
      end if;
      if new.attempts is distinct from old.attempts
         or new.progress is distinct from old.progress
         or new.result_ref is distinct from old.result_ref
         or new.error_code is distinct from old.error_code
         or new.heartbeat_at is null then
        raise exception 'runs_transition_refused: lease may only set status+heartbeat';
      end if;
    elsif v_op = 'reap' then
      if not (old.status = 'running' and new.status = 'failed' and new.error_code = 'orphaned') then
        raise exception 'runs_transition_refused: reap may only do running->failed(orphaned)';
      end if;
      if new.attempts is distinct from old.attempts
         or new.progress is distinct from old.progress
         or new.result_ref is distinct from old.result_ref
         or new.heartbeat_at is distinct from old.heartbeat_at then
        raise exception 'runs_transition_refused: reap may only set status+error_code';
      end if;
    elsif v_op = 'requeue' then
      if not (old.status = 'failed' and new.status = 'queued') then
        raise exception 'runs_transition_refused: requeue may only do failed->queued';
      end if;
      if old.attempts >= c_attempt_cap then
        raise exception 'runs_transition_refused: failed at the attempt cap is terminal';
      end if;
      if new.attempts is distinct from (old.attempts + 1) then
        raise exception 'runs_transition_refused: requeue must increment attempts by exactly 1';
      end if;
      if new.error_code is not null
         or new.progress is distinct from old.progress
         or new.result_ref is distinct from old.result_ref
         or new.heartbeat_at is distinct from old.heartbeat_at then
        raise exception 'runs_transition_refused: requeue may only set status+attempts+clear error_code';
      end if;
    else
      raise exception 'runs_transition_refused: unknown queue op';
    end if;
    return new;
  end if;

  if v_is_owner then
    -- Owner scaffolding/repair — outside the DB-enforceable trust boundary and
    -- never a PostgREST identity (see threat reasoning in the header).
    return new;
  end if;

  -- TENANT PATH (authenticated writers under RLS; also any raw service_role
  -- reach, which gets no exemption). Identity first:
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.client_id is distinct from old.client_id
     or new.kind is distinct from old.kind
     or new.property_id is distinct from old.property_id
     or new.input_url is distinct from old.input_url
     or new.created_at is distinct from old.created_at then
    raise exception 'runs_transition_refused: row identity is immutable';
  end if;
  -- requested_by: only the ON DELETE SET NULL shape (value -> NULL) is legal;
  -- a rewrite to another user is refused.
  if new.requested_by is distinct from old.requested_by and new.requested_by is not null then
    raise exception 'runs_transition_refused: requested_by may not be rewritten';
  end if;
  -- attempts NEVER change on a tenant edge (increment is requeue-only; reset,
  -- jump, and decrement are all structurally impossible here).
  if new.attempts is distinct from old.attempts then
    raise exception 'runs_transition_refused: attempts are queue-managed';
  end if;

  if new.status = old.status then
    if old.status = 'running' then
      -- The lease-fenced holder's heartbeat/progress writes. (updated_at is
      -- trigger-set and never compared. Any FUTURE progress write rides this
      -- same edge and the same app-side status+attempts fencing — see
      -- src/lib/runs/live.ts.)
      if new.result_ref is distinct from old.result_ref
         or new.error_code is distinct from old.error_code then
        raise exception 'runs_transition_refused: only heartbeat/progress may change on a running run';
      end if;
      return new;
    end if;
    -- Non-running same-status updates: ONLY the requested_by->NULL carve-out
    -- (validated above) — every payload column must be untouched.
    if new.progress is distinct from old.progress
       or new.heartbeat_at is distinct from old.heartbeat_at
       or new.result_ref is distinct from old.result_ref
       or new.error_code is distinct from old.error_code then
      raise exception 'runs_transition_refused: % runs are not writable', old.status;
    end if;
    return new;
  end if;

  -- Status EDGES legal for a tenant writer:
  if old.status = 'queued' and new.status = 'canceled' then
    if new.progress is distinct from old.progress
       or new.heartbeat_at is distinct from old.heartbeat_at
       or new.result_ref is distinct from old.result_ref
       or new.error_code is distinct from old.error_code then
      raise exception 'runs_transition_refused: cancel may only set status';
    end if;
    return new;
  end if;
  if old.status = 'running' and new.status = 'succeeded' then
    -- Holder completion; error_code must stay null (0011 CHECK also pins this).
    if new.error_code is distinct from old.error_code then
      raise exception 'runs_transition_refused: succeeded carries no error_code';
    end if;
    return new;
  end if;
  if old.status = 'running' and new.status = 'failed' then
    -- Holder failure — 'orphaned' is the reap-only flavor.
    if new.error_code is null or new.error_code = 'orphaned' then
      raise exception 'runs_transition_refused: holder failure needs a non-orphaned error_code';
    end if;
    if new.result_ref is distinct from old.result_ref then
      raise exception 'runs_transition_refused: a failed run carries no result_ref';
    end if;
    return new;
  end if;

  raise exception 'runs_transition_refused: illegal transition % -> %', old.status, new.status;
end;
$$;

/* ============================ DOWN (manual rollback — NOT executed) ==========
   The migration runner executes ONLY the UP above; a devops rollback step runs
   the statement below — the 0012 function definition VERBATIM (re-headed with
   OR REPLACE, since the function exists) — returning the schema exactly to its
   0015 state (input_url mutable again on the tenant/privileged paths):

create or replace function app.runs_transition_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_op       text;
  v_owner    name;
  v_is_owner boolean;
  -- STRUCTURAL retry cap — mirrors RETRY_ATTEMPT_CAP (see header).
  c_attempt_cap constant int := 3;
begin
  v_op := nullif(pg_catalog.current_setting('app.runs_queue_op', true), '');
  select pg_catalog.pg_get_userbyid(c.relowner) into v_owner
  from pg_catalog.pg_class c where c.oid = tg_relid;
  v_is_owner := (current_user = v_owner);

  if v_op is not null then
    -- PRIVILEGED PATH: requires the definer execution context too (threat
    -- reasoning in the header — a GUC set by a non-owner is a spoof attempt).
    if not v_is_owner then
      raise exception 'runs_transition_refused: privileged queue op outside definer context';
    end if;

    -- Identity is immutable on privileged edges as well.
    if new.id is distinct from old.id
       or new.tenant_id is distinct from old.tenant_id
       or new.client_id is distinct from old.client_id
       or new.kind is distinct from old.kind
       or new.property_id is distinct from old.property_id
       or new.requested_by is distinct from old.requested_by
       or new.created_at is distinct from old.created_at then
      raise exception 'runs_transition_refused: row identity is immutable';
    end if;

    if v_op = 'lease' then
      if not (old.status = 'queued' and new.status = 'running') then
        raise exception 'runs_transition_refused: lease may only do queued->running';
      end if;
      if new.attempts is distinct from old.attempts
         or new.progress is distinct from old.progress
         or new.result_ref is distinct from old.result_ref
         or new.error_code is distinct from old.error_code
         or new.heartbeat_at is null then
        raise exception 'runs_transition_refused: lease may only set status+heartbeat';
      end if;
    elsif v_op = 'reap' then
      if not (old.status = 'running' and new.status = 'failed' and new.error_code = 'orphaned') then
        raise exception 'runs_transition_refused: reap may only do running->failed(orphaned)';
      end if;
      if new.attempts is distinct from old.attempts
         or new.progress is distinct from old.progress
         or new.result_ref is distinct from old.result_ref
         or new.heartbeat_at is distinct from old.heartbeat_at then
        raise exception 'runs_transition_refused: reap may only set status+error_code';
      end if;
    elsif v_op = 'requeue' then
      if not (old.status = 'failed' and new.status = 'queued') then
        raise exception 'runs_transition_refused: requeue may only do failed->queued';
      end if;
      if old.attempts >= c_attempt_cap then
        raise exception 'runs_transition_refused: failed at the attempt cap is terminal';
      end if;
      if new.attempts is distinct from (old.attempts + 1) then
        raise exception 'runs_transition_refused: requeue must increment attempts by exactly 1';
      end if;
      if new.error_code is not null
         or new.progress is distinct from old.progress
         or new.result_ref is distinct from old.result_ref
         or new.heartbeat_at is distinct from old.heartbeat_at then
        raise exception 'runs_transition_refused: requeue may only set status+attempts+clear error_code';
      end if;
    else
      raise exception 'runs_transition_refused: unknown queue op';
    end if;
    return new;
  end if;

  if v_is_owner then
    -- Owner scaffolding/repair — outside the DB-enforceable trust boundary and
    -- never a PostgREST identity (see threat reasoning in the header).
    return new;
  end if;

  -- TENANT PATH (authenticated writers under RLS; also any raw service_role
  -- reach, which gets no exemption). Identity first:
  if new.id is distinct from old.id
     or new.tenant_id is distinct from old.tenant_id
     or new.client_id is distinct from old.client_id
     or new.kind is distinct from old.kind
     or new.property_id is distinct from old.property_id
     or new.created_at is distinct from old.created_at then
    raise exception 'runs_transition_refused: row identity is immutable';
  end if;
  -- requested_by: only the ON DELETE SET NULL shape (value -> NULL) is legal;
  -- a rewrite to another user is refused.
  if new.requested_by is distinct from old.requested_by and new.requested_by is not null then
    raise exception 'runs_transition_refused: requested_by may not be rewritten';
  end if;
  -- attempts NEVER change on a tenant edge (increment is requeue-only; reset,
  -- jump, and decrement are all structurally impossible here).
  if new.attempts is distinct from old.attempts then
    raise exception 'runs_transition_refused: attempts are queue-managed';
  end if;

  if new.status = old.status then
    if old.status = 'running' then
      -- The lease-fenced holder's heartbeat/progress writes. (updated_at is
      -- trigger-set and never compared. Any FUTURE progress write rides this
      -- same edge and the same app-side status+attempts fencing — see
      -- src/lib/runs/live.ts.)
      if new.result_ref is distinct from old.result_ref
         or new.error_code is distinct from old.error_code then
        raise exception 'runs_transition_refused: only heartbeat/progress may change on a running run';
      end if;
      return new;
    end if;
    -- Non-running same-status updates: ONLY the requested_by->NULL carve-out
    -- (validated above) — every payload column must be untouched.
    if new.progress is distinct from old.progress
       or new.heartbeat_at is distinct from old.heartbeat_at
       or new.result_ref is distinct from old.result_ref
       or new.error_code is distinct from old.error_code then
      raise exception 'runs_transition_refused: % runs are not writable', old.status;
    end if;
    return new;
  end if;

  -- Status EDGES legal for a tenant writer:
  if old.status = 'queued' and new.status = 'canceled' then
    if new.progress is distinct from old.progress
       or new.heartbeat_at is distinct from old.heartbeat_at
       or new.result_ref is distinct from old.result_ref
       or new.error_code is distinct from old.error_code then
      raise exception 'runs_transition_refused: cancel may only set status';
    end if;
    return new;
  end if;
  if old.status = 'running' and new.status = 'succeeded' then
    -- Holder completion; error_code must stay null (0011 CHECK also pins this).
    if new.error_code is distinct from old.error_code then
      raise exception 'runs_transition_refused: succeeded carries no error_code';
    end if;
    return new;
  end if;
  if old.status = 'running' and new.status = 'failed' then
    -- Holder failure — 'orphaned' is the reap-only flavor.
    if new.error_code is null or new.error_code = 'orphaned' then
      raise exception 'runs_transition_refused: holder failure needs a non-orphaned error_code';
    end if;
    if new.result_ref is distinct from old.result_ref then
      raise exception 'runs_transition_refused: a failed run carries no result_ref';
    end if;
    return new;
  end if;

  raise exception 'runs_transition_refused: illegal transition % -> %', old.status, new.status;
end;
$$;
============================================================================ */
