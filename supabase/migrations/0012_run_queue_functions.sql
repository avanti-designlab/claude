-- ============================================================================
-- 0012_run_queue_functions.sql — the run-queue EXECUTION layer's DB surface:
-- the atomic lease + the two sweeper maintenance ops (reviewed SECURITY DEFINER
-- functions), the cross-tenant lease index, AND the transition-legality trigger
-- that makes the pinned state machine DATABASE-ENFORCED.
--
-- Governed post-freeze change (CLAUDE.md rule 1) — the separately-gated
-- queue-infra block (BUILD-STATE 2026-07-10 ARCHITECTURE RULING, amendment A8:
-- Code Review + a QA adversarial concurrency/recovery suite), amended per the
-- Orchestrator's QA-F2 ruling (2026-07-10): the transition-legality trigger is
-- AUTHORIZED and folded INTO this migration — the state machine and its
-- structural guard are one concern and must never land separately. Migrations
-- 0001–0011 are FROZEN and untouched; this file only ADDS functions, one index,
-- and one trigger.
--
-- SUPERSEDE NOTE (honest-docs precedent): migration 0011's header says the
-- transition graph is "app-logic" pinned by src/lib/runs/transitions.ts. That
-- claim is SUPERSEDED by this migration: A4's enforcement clause is formally
-- amended to "pinned in tests, ENFORCED BY THE DATABASE" for runs. The
-- transitions.ts contract remains the readable spec + app-side predicate; the
-- trigger below is the enforcement.
--
-- ────────────────────────────────────────────────────────────────────────────
-- WHY THE FUNCTIONS ARE SECURITY DEFINER, AND WHO MAY EXECUTE THEM (A1)
-- ────────────────────────────────────────────────────────────────────────────
-- `public.runs` is FORCE ROW LEVEL SECURITY and its policies pin every row to
-- `app.tenant_id()` (migration 0011). The processor's ONE unavoidably
-- cross-tenant step is picking the globally-oldest queued run — it cannot carry
-- a single tenant's JWT and still see another tenant's queued work. The ruling
-- (A1) permits exactly this as the sole service-role-class operation, realised
-- as reviewed SECURITY DEFINER functions with EXECUTE locked down. Everything
-- ELSE the processor does — reading the leased run's property/client, running
-- the engine, persisting the artifact, heart-beating, and completing the run
-- (running → succeeded|failed) — happens through an RLS-enforced per-run client
-- scoped to the leased run's tenant (see src/lib/runs/*), NEVER through these
-- functions and NEVER through raw service-role table access.
--
-- Scope of these three functions (identical, narrow class — cross-tenant QUEUE
-- STATE only; they touch ONLY the runs table's own state columns, never any
-- tenant DATA table):
--   * lease_next_run()        — claim the oldest queued run (queued → running).
--   * reap_orphaned_runs(ts)  — a crashed processor stops heart-beating; the
--                               sweeper marks its stale RUNNING row failed
--                               (running → failed, error_code 'orphaned').
--   * requeue_failed_runs(...)— capped, backed-off retry of failed runs
--                               (failed → queued, attempts+1) to a cap.
-- Each function is SECURITY DEFINER (runs as the migration owner — `postgres`
-- in Supabase / the superuser in the harness — which BYPASSRLS, exactly like
-- the 0007 access-token hook) and `set search_path = ''` so every reference is
-- schema-qualified and unshadowable. Each performs ONLY transitions the pinned
-- legality table allows (src/lib/runs/transitions.ts; ruling A4) — and the
-- trigger below now REFUSES everything else at the database, so the functions'
-- discipline is structural, not merely reviewed-in.
--
-- EXECUTE lockdown: a newly created function grants EXECUTE to PUBLIC by
-- default. We REVOKE that (and explicitly from authenticated/anon, who are
-- PUBLIC members) and grant EXECUTE ONLY to `service_role`. Consequences:
--   * a signed-in tenant user's request runs as `authenticated` (PostgREST SET
--     ROLE off the reserved `role` claim) → NO EXECUTE → permission denied. A
--     tenant user can therefore never lease, reap, or requeue ANY run — not even
--     their own tenant's — so the cross-tenant surface is unreachable from the
--     tenant-facing API. (Proven in supabase/tests/queue/*.pg.test.ts.)
--   * `anon` → NO EXECUTE → denied.
--   * ONLY a request bearing the service-role key (SUPABASE_SERVICE_ROLE_KEY,
--     server-only, never in the client bundle — env.server.ts) SET ROLEs to
--     `service_role` and may call these. That key lives ONLY in the processor's
--     server runtime, and the processor's service-role client calls NOTHING but
--     these three RPCs (Code Review-enforced; ruling A1 "any other service-role
--     use on the run path = automatic reject").
-- `service_role` is Supabase-provided (BYPASSRLS); the isolation harness
-- pre-creates it as a NOLOGIN role before migrations run, same pattern as
-- authenticated/anon/supabase_auth_admin (helpers/harness.ts ensureDbRoles).
--
-- ────────────────────────────────────────────────────────────────────────────
-- CALLER DISCRIMINATION FOR THE TRIGGER — THREAT REASONING (QA-F2 ruling §4)
-- ────────────────────────────────────────────────────────────────────────────
-- The trigger must tell the PRIVILEGED paths (the three functions) apart from
-- raw table writes, to a 0-bypass standard against the PostgREST surface.
-- Mechanism: a privileged edge requires BOTH
--   (1) the transaction-local GUC `app.runs_queue_op` = 'lease'|'reap'|'requeue',
--       set by the SECURITY DEFINER function immediately before its UPDATE and
--       cleared immediately after, AND
--   (2) `current_user` = the runs TABLE OWNER (the migration role — `postgres`
--       in Supabase and in the harness) — which is exactly the execution
--       context inside a SECURITY DEFINER function owned by that role.
-- Why each alone is insufficient, and why together they hold:
--   * GUC alone: PostgREST materialises ONLY request.jwt.claims /
--     request.headers / request.cookies as GUCs — no header or forged claim can
--     create `app.runs_queue_op` (claims land INSIDE request.jwt.claims, never
--     as standalone GUCs), and no exposed RPC runs set_config (the QA catalog
--     tripwire pins that NO public-schema function is executable by
--     authenticated/anon, so a future unlocked RPC fails the suite by default).
--     But a hypothetical arbitrary-SQL context running as `authenticated`
--     COULD call set_config — so the GUC alone is not enough.
--   * Owner alone: would silently privilege every statement the owner runs
--     (migration scripts, support SQL), losing the explicit-intent signal.
--   * Together: the attacker would need to EXECUTE AS the table owner, which no
--     PostgREST identity (authenticated / anon / service_role) is or can SET
--     ROLE to (no membership). Probed in the QA-suite direction: an
--     authenticated caller that sets the GUC by hand is still refused
--     (supabase/tests/queue/transition-guard.pg.test.ts).
-- OWNER-WITHOUT-GUC FALLBACK: a raw statement by the table owner (no GUC) is
-- ALLOWED. A Postgres owner/superuser is outside every DB-enforceable trust
-- boundary (it can drop this trigger); exempting it adds ZERO
-- PostgREST-reachable surface and keeps migration/repair/test scaffolding
-- honest. Documented consequence: manual support repair on hosted Supabase runs
-- as `postgres` (the owner) and is exempt — do it deliberately.
-- service_role RAW table writes (which must never exist per A1) get NO
-- exemption: service_role is neither the owner nor GUC-bearing, so an illegal
-- edge from a leaked service key is refused by the database as well as by Code
-- Review.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Cross-tenant lease index. Deferred here from 0011 (its header: "the
-- cross-tenant lease index lands WITH lease_next_run()"). Partial on the queued
-- frontier only, ordered exactly as the lease scans it — so the FOR UPDATE SKIP
-- LOCKED claim reads the single oldest queued row without scanning terminal
-- history. Deliberately NOT tenant_id-leading: the lease is global-oldest-first
-- across all tenants by design (runs already has the tenant_id-leading history
-- index runs_client_created_idx for the app-facing per-tenant reads).
-- ----------------------------------------------------------------------------
create index runs_lease_idx on public.runs (created_at, id) where status = 'queued';

-- ----------------------------------------------------------------------------
-- lease_next_run() — the atomic claim. Picks the globally-oldest queued run,
-- locks it with FOR UPDATE SKIP LOCKED (concurrent leasers skip a locked row
-- and take the next, so two processors can NEVER lease the same run — proven
-- under real concurrency in the QA suite), flips it queued → running, and stamps
-- the heartbeat. Returns the leased row, or NULL when the queue is empty.
--
-- Takes NO parameters: nothing the caller sends may influence WHICH run is
-- leased (ruling A2 "no request-derived run selection beyond the lease"). The
-- attempt counter is NOT touched here — attempts increments only on the
-- failed→queued retry re-queue (requeue_failed_runs), per the pinned transition
-- table; a lease is queued→running only.
-- ----------------------------------------------------------------------------
create function public.lease_next_run()
returns public.runs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs;
begin
  select r.*
    into v_run
  from public.runs r
  where r.status = 'queued'
  order by r.created_at asc, r.id asc
  for update skip locked
  limit 1;

  if not found then
    return null; -- empty queue (or every queued row already locked by a peer)
  end if;

  -- Declare the privileged op for the transition guard (transaction-local; see
  -- CALLER DISCRIMINATION above), do the ONE legal edge, clear it immediately.
  perform pg_catalog.set_config('app.runs_queue_op', 'lease', true);
  update public.runs
  set status = 'running',
      heartbeat_at = now()
  where id = v_run.id
  returning * into v_run;
  perform pg_catalog.set_config('app.runs_queue_op', '', true);

  return v_run;
end;
$$;

comment on function public.lease_next_run() is
  'Queue-infra (ruling A1/A8). Atomically claims the oldest queued run (FOR UPDATE SKIP LOCKED), flips queued->running, stamps heartbeat_at, returns the row or NULL. SECURITY DEFINER (bypasses runs FORCE RLS for the sole cross-tenant lease); EXECUTE granted ONLY to service_role. No parameters — caller cannot influence which run is leased. Declares app.runs_queue_op=lease for the transition guard.';

-- ----------------------------------------------------------------------------
-- reap_orphaned_runs(p_stale_before) — the honesty backstop (ruling A5/A6). A
-- crashed/killed processor leaves a run stuck RUNNING with a frozen heartbeat.
-- The sweeper passes p_stale_before = now() - (maxDuration + 60s); any running
-- row whose heartbeat is STRICTLY older than that (or never stamped) is marked
-- failed/'orphaned' — so a run's visible state is always real, never
-- stuck-running. A heartbeat exactly AT the cutoff is spared (strict <; the TS
-- mirror isHeartbeatStale matches this semantics). running → failed here is the
-- SWEEP-ONLY transition (transitions.ts). Returns the reaped ids (count only is
-- logged; ids never).
-- ----------------------------------------------------------------------------
create function public.reap_orphaned_runs(p_stale_before timestamptz)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.set_config('app.runs_queue_op', 'reap', true);
  return query
  update public.runs
  set status = 'failed',
      error_code = 'orphaned'
  where status = 'running'
    and (heartbeat_at is null or heartbeat_at < p_stale_before)
  returning id;
  perform pg_catalog.set_config('app.runs_queue_op', '', true);
end;
$$;

comment on function public.reap_orphaned_runs(timestamptz) is
  'Queue-infra sweeper (ruling A5/A6). Marks stale-heartbeat running runs failed/orphaned (running->failed, sweep-only transition) so state is never stuck-running. Caller passes now()-(maxDuration+60s); AT-cutoff heartbeats are spared (strict <). SECURITY DEFINER; EXECUTE only to service_role. Declares app.runs_queue_op=reap for the transition guard.';

-- ----------------------------------------------------------------------------
-- requeue_failed_runs(p_cap, p_base_backoff, p_max_backoff) — capped, backed-off
-- retry (ruling A6). Re-queues a failed run (failed → queued, attempts+1,
-- error_code cleared — a queued row may carry NO error_code, CHECK
-- runs_error_code_only_on_failed) once it is (a) under the attempt cap and
-- (b) past its backoff window: eligible when time-in-failed
-- >= least(base * (attempts+1), max) — backoff grows with attempts, capped.
-- Retry policy matches src/lib/runs/transitions.ts shouldRetry() exactly
-- (attempts < cap), and the transition guard additionally enforces the
-- STRUCTURAL cap (3) + the exactly-+1 increment regardless of p_cap, so a
-- mis-called cap cannot exceed the ratified one. Returns the re-queued ids.
-- ----------------------------------------------------------------------------
create function public.requeue_failed_runs(
  p_cap int,
  p_base_backoff interval,
  p_max_backoff interval
)
returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.set_config('app.runs_queue_op', 'requeue', true);
  return query
  update public.runs
  set status = 'queued',
      attempts = attempts + 1,
      error_code = null
  where status = 'failed'
    and attempts < p_cap
    and updated_at <= now() - least(p_base_backoff * (attempts + 1), p_max_backoff)
  returning id;
  perform pg_catalog.set_config('app.runs_queue_op', '', true);
end;
$$;

comment on function public.requeue_failed_runs(int, interval, interval) is
  'Queue-infra sweeper (ruling A6). Capped, backed-off retry of failed runs (failed->queued, attempts+1, error_code cleared) while attempts < cap and time-in-failed >= least(base*(attempts+1), max). Mirrors transitions.ts shouldRetry; the transition guard structurally caps attempts at 3 regardless of p_cap. SECURITY DEFINER; EXECUTE only to service_role. Declares app.runs_queue_op=requeue for the transition guard.';

-- ----------------------------------------------------------------------------
-- EXECUTE lockdown — revoke the default PUBLIC execute, deny authenticated/anon
-- explicitly (belt-and-braces + documents intent), grant only service_role.
-- ----------------------------------------------------------------------------
revoke execute on function public.lease_next_run() from public;
revoke execute on function public.lease_next_run() from authenticated, anon;
grant  execute on function public.lease_next_run() to service_role;

revoke execute on function public.reap_orphaned_runs(timestamptz) from public;
revoke execute on function public.reap_orphaned_runs(timestamptz) from authenticated, anon;
grant  execute on function public.reap_orphaned_runs(timestamptz) to service_role;

revoke execute on function public.requeue_failed_runs(int, interval, interval) from public;
revoke execute on function public.requeue_failed_runs(int, interval, interval) from authenticated, anon;
grant  execute on function public.requeue_failed_runs(int, interval, interval) to service_role;

-- ============================================================================
-- TRANSITION-LEGALITY GUARD (Orchestrator QA-F2 ruling — AUTHORIZED, folded
-- into 0012 so the state machine and its guard land as one reviewable unit).
--
-- THE LEGAL EDGE SET — anything not listed here is REFUSED by the database:
--   queued  → running            via lease only            (GUC 'lease' + owner)
--   running → running            heartbeat/progress only — the lease-fenced
--                                holder's writes. The app-side status+attempts
--                                CAS (src/lib/runs/live.ts) is the ONE fencing
--                                mechanism: this trigger pins WHICH edges and
--                                columns are legal; the CAS pins WHO — a
--                                zombie's fenced write matches 0 rows and never
--                                reaches this trigger.
--   running → succeeded|failed   the lease-fenced holder (same mechanism);
--                                error_code 'orphaned' is REFUSED on this path
--   running → failed('orphaned') via reap only             (GUC 'reap' + owner)
--   failed  → queued             via requeue only          (GUC 'requeue' + owner),
--                                attempts = OLD+1 exactly (never reset, never
--                                jumped, never decremented) AND OLD.attempts <
--                                the STRUCTURAL cap 3 — failed-at-cap is
--                                TERMINAL (the attempts-reset exploit is
--                                impossible at the DB, not merely illegal)
--   queued  → canceled           tenant writers' raw edge (RLS pins tenant +
--                                writer floor; the app CASes on queued)
--   succeeded / canceled / failed-at-cap: NO outbound edges.
--
-- ROW IDENTITY IMMUTABLE POST-INSERT (ruling §3): tenant_id / client_id / kind
-- / property_id / requested_by (plus id / created_at — no legal edge touches
-- them). One carve-out: requested_by → NULL is allowed on the tenant path,
-- because the 0011 schema's ON DELETE SET NULL (requested_by) fires exactly
-- that UPDATE (as the deleting admin's role) when the enqueuing tenant_user is
-- removed; a REWRITE to another user stays refused.
--
-- The structural attempt cap (3) mirrors RETRY_ATTEMPT_CAP
-- (src/lib/runs/config.ts — ⚑ A6 provisional, pinned by thresholds-pin.test.ts).
-- Ratifying a new cap is ONE reviewed edit here + there.
-- ============================================================================
create function app.runs_transition_guard()
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

-- Not callable directly by anyone (fired as a table trigger; trigger firing
-- does not require the invoker to hold EXECUTE).
revoke all on function app.runs_transition_guard() from public;

comment on function app.runs_transition_guard() is
  'Transition-legality guard for public.runs (Orchestrator QA-F2 ruling). Pins the legal edge set at the DATABASE: queued->running lease-only; running->running heartbeat/progress + running->succeeded|failed for the lease-fenced holder; running->failed(orphaned) reap-only; failed->queued requeue-only with attempts exactly +1 and structural cap 3; queued->canceled for tenant writers; terminal states have no outbound edges; row identity immutable (requested_by may only go to NULL — the FK SET NULL shape). Privileged ops = app.runs_queue_op GUC + table-owner execution context; owner-without-GUC is exempt scaffolding/repair (threat reasoning in the 0012 header).';

create trigger runs_transition_guard
  before update on public.runs
  for each row execute function app.runs_transition_guard();

/* ============================ DOWN (manual rollback — NOT executed) ==========
   The migration runner executes ONLY the UP above; a devops rollback step runs:

   drop trigger  if exists runs_transition_guard on public.runs;
   drop function if exists app.runs_transition_guard();
   drop function if exists public.requeue_failed_runs(int, interval, interval);
   drop function if exists public.reap_orphaned_runs(timestamptz);
   drop function if exists public.lease_next_run();
   drop index    if exists public.runs_lease_idx;
============================================================================ */
