# Environments, secrets & deploy topology
### Owner: devops-deployment · Phase 0.1

## Topology (staging/prod split)

| | Staging | Production |
|---|---|---|
| Git branch | `staging` | `main` |
| Vercel | same project, **Preview** env pinned to `staging` branch (assign a fixed domain, e.g. `staging.<domain>`) | **Production** env, deploys from `main` |
| Supabase | dedicated project `<name>-staging` | dedicated project `<name>-prod` |
| Cloudflare Workers | `*-staging` worker names/routes | production worker routes |

Rules:
- **Two separate Supabase projects.** Staging code never points at prod data. Migrations run on staging first; prod only after verification (Backend + DevOps agents together).
- Vercel Git integration deploys automatically: PR → preview URL, `staging` → staging domain, `main` → production. Promotion to prod = merge `staging` → `main` after the regression gate (QA suites) is green.
- Rollback of a bad deploy: Vercel "Instant Rollback" to the previous production deployment; database rollbacks via down-migrations (never manual edits).

## Environment variables

Template: `.env.example` (checked in, no values). Local dev: copy to `.env.local` (gitignored). Vercel: set per-environment values in Project → Settings → Environment Variables (Production / Preview / Development). CI sets **no env vars at all** — the build is designed to need none at this stage (env validation happens at call time, not import time). Do not "fix" CI by adding placeholder secrets.

| Variable | Scope | Purpose |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client+server | Supabase project URL (differs staging/prod) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client+server | Supabase anon (publishable) key — safe to expose; RLS is the enforcement layer |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Bypasses RLS. Admin/migration tooling AND the run-queue's ONE service-role-class op — the lease/sweep SECURITY DEFINER RPCs (migration 0012, ruling A1). Never in client code; never for tenant data on the run path |
| `SUPABASE_DB_URL` | tooling only | Direct Postgres connection for migrations |
| `SUPABASE_JWT_SECRET` | **server only** | Signs the short-lived per-run tenant JWTs the processor mints (ruling A1). Supabase → Settings → API → JWT Settings → JWT Secret. PostgREST verifies minted tokens against it |
| `RUNS_PROCESSOR_SECRET` | **server only** | Shared secret the enqueue kick presents to, and `/api/runs/{process,sweep}` verify (timing-safe). NEVER logged. Unset ⇒ endpoints refuse 503 + kick skipped (sweeper/cron backstop) |
| `RUNS_PROCESSOR_URL` | server only (optional) | Base origin the enqueue self-kick posts to. Defaults to `http://127.0.0.1:$PORT` (local dev). Set to the deployment origin when hosted |

Phase 1 keys (added when their modules build; per-tenant where the tenant supplies their own — stored in Supabase Vault, not env, when tenant-scoped): `ANTHROPIC_API_KEY`, citation-data provider key (Profound-class), Ayrshare-class key, humanizer + AI-detection keys, GA4/GSC OAuth creds, call-tracking key, Higgsfield/Motion (MCP) creds, `CLOUDFLARE_API_TOKEN`.

## Secrets rules (doc 03 §5, doc 04)

1. Raw credentials never in tables, code, logs, or the repo. Client site/API creds go in **Supabase Vault**; `properties.auth_ref` stores only the vault reference.
2. Platform keys live in Vercel env vars (per environment) and GitHub Actions secrets (CI), rotated on personnel/vendor change.
3. `SUPABASE_SERVICE_ROLE_KEY` is the most dangerous secret in the system — server-only, admin tooling only.

## One-time provisioning (operator actions — require your accounts)

1. **Vercel:** create project from this repo (`vercel link`), root directory = repo root, framework Next.js. Create the `staging` branch and assign it a fixed preview domain. Set the env vars above per environment.
2. **Supabase:** create the two projects (staging, prod). Record URLs + keys into Vercel env vars and `.env.local`. Enable Vault on both.
3. **Cloudflare:** create/confirm the Workers account and an API token with Workers deploy rights (needed later for the edge auto-fix method — Phase 1.3). Per-client routes get provisioned at client onboarding, one isolated worker per client domain (doc 04 §5).
4. **GitHub:** branch protection on `main` and `staging` — require the CI workflow green before merge.

## CI/CD

`.github/workflows/ci.yml` runs on every push/PR: install → lint → typecheck → build. Test suites (QA agent) are added from build step 0.2 onward and become required. Deploys are owned by Vercel Git integration, not CI.

---

## Background scan run-queue (queue-infra block · ruling 2026-07-10 A3/A9)

### Owner: lead-backend-data-architect · added with migration 0012 + `/api/runs/*`

Long-running read-only scans run in the background: enqueue writes a `queued`
`runs` row and fires a non-blocking **kick** at the Node processor route, which
leases the oldest queued run (`lease_next_run()`), executes it under an honest
crawl budget, heartbeats, and records `succeeded|failed`. A **sweeper** reaps
stale-heartbeat orphans and re-queues failed runs under a capped backoff.

**Runs locally with NO cron (A9).** Under `npm run dev`, set
`SUPABASE_JWT_SECRET` + `RUNS_PROCESSOR_SECRET` (and the four Supabase vars);
the enqueue's self-kick then drives the whole loop. Each processed run kicks the
next pickup, so the queue self-drains.

**Manual / dev sweep trigger** (the backstop for a dropped kick or a crashed
processor — run it by hand, or on a timer of your choosing):

```bash
curl -X POST http://127.0.0.1:3000/api/runs/sweep \
     -H "authorization: Bearer $RUNS_PROCESSOR_SECRET"
# → {"reaped":N,"requeued":M}   (redacted counts only)
```

The processor can be poked the same way (`/api/runs/process`) — it leases and
runs at most one run per call. The sweep endpoint kicks the processor
**unconditionally** after every pass (QA F1): the sweep DB functions never touch
a *queued* row (reap = running-only, requeue = failed-only), so a queued run
whose enqueue kick was dropped is recovered only by that kick-triggered lease —
one sweep covers orphan reaping, capped retry, AND stranded-pickup in a single
call.

**A3 timing budget (single source of truth: `src/lib/runs/config.ts`).** The
route `maxDuration` (60s) and the crawl wall-clock budget derive from one
constant with `budget ≤ maxDuration − overhead` (test-pinned). Truncation is the
crawler's honest `budget_exhausted`, never a platform kill.

**Hosted scheduling is NON-OPTIONAL (config-only, not required locally).** In a
hosted deployment the enqueue self-kick is best-effort — a cold start, a
timeout, or a network blip can drop it, and NOTHING else picks up a queued run
until the next sweep. A scheduled sweep is therefore a REQUIRED part of hosting
this system, not an optimization:
- **Vercel Cron** — add to `vercel.json` a cron POSTing `/api/runs/sweep`
  (which also kicks pickup — one job covers everything). Hobby allows **one
  cron job, once per day** — stated honestly: on Hobby, a dropped kick can
  leave a queued scan (or a crashed run's retry) waiting **up to 24 hours**
  before the daily sweep recovers it. Acceptable for tenant-#1 dogfooding;
  NOT acceptable once clients watch scan status — Pro's finer schedules (or
  pg_cron) are the fix, and the run-trigger UI's "queued" state must render
  honestly meanwhile. The cron request must carry `RUNS_PROCESSOR_SECRET`
  (Vercel Cron can send an `Authorization` header) — the endpoints reject
  anything else.
- **pg_cron alternative** — schedule the sweep/pickup from Postgres itself if you
  prefer not to depend on platform cron (calls the same SECURITY DEFINER
  functions directly under the service role).
- **maxDuration by plan** — Hobby caps a Node function at 60s (the current
  default), Pro at 300s. Raising the budget for Pro is a change to the ONE config
  constant (+ this route literal), test-pinned — not a code fork.

**Secrets discipline.** `RUNS_PROCESSOR_SECRET` and `SUPABASE_JWT_SECRET` are
server-only and never logged; run telemetry is redacted (closed-enum
`error_code` + counts, never URLs/ids/payloads).

---

## Authentication: enable the claim-minting hook + create tenant #1

### Owner: lead-backend-data-architect · added with the auth-claims layer (migration 0007)

The RLS that isolates every tenant reads three claims from each user's JWT —
`tenant_id`, `user_role`, `client_id`. Those claims are **not** in a Supabase
token by default; they are injected by the **Custom Access Token hook**
(`auth_hooks.custom_access_token_hook`, migration 0007), which looks the user up
in `tenant_users` and mints the claims **server-side, from the database only**.
The app role travels in the **non-reserved `user_role` claim** (migration 0008);
the standard `role` claim stays GoTrue's reserved DB-role claim (`authenticated`)
— see the RESOLVED note below.

**Migration 0007 creates the hook function but CANNOT enable it** — enabling a
hook is a project setting, not SQL. Until you do the two steps below, every
logged-in user is treated as having no tenant and sees nothing (fail closed).

> All SQL below runs in **Supabase Dashboard → SQL Editor** (pick the right
> project: staging vs prod). Copy a block, replace the `<...>` placeholders, Run.

### Step 1 — enable the hook (one click, per project)

1. Supabase Dashboard → **Authentication** → **Hooks** (also labelled *Auth
   Hooks*).
2. Under **Custom Access Token**, click **Add hook** / **Enable**.
3. Choose **Postgres** as the hook type, schema **`auth_hooks`**, function
   **`custom_access_token_hook`**.
4. Save. New logins now carry `tenant_id` / `user_role` / `client_id`. (Existing
   sessions pick them up on their next token refresh — within the hour, or
   immediately after a fresh sign-in.)

Do this on **both** the staging and prod Supabase projects.

### Step 2 — create your agency (tenant #1) and make yourself its admin

**Prerequisite — your auth user must exist first.** The hook links by
`auth.users.id`, so you need a login before you can be made an admin. Either:
sign in once through the app (once the login screen ships), **or** create the
user now in Dashboard → **Authentication** → **Users** → **Add user** (set an
email + password).

```sql
-- 2a) Create your agency as tenant #1. Replace the name; copy the returned id.
insert into public.tenants (name)
values ('<YOUR AGENCY NAME>')
returning id;

-- 2b) Look up your auth user id by the email you signed up / created with.
select id, email from auth.users where email = '<YOUR LOGIN EMAIL>';

-- 2c) Make yourself an agency_admin of that tenant. Paste the two ids above.
insert into public.tenant_users (tenant_id, auth_user_id, role)
values ('<TENANT_ID_FROM_2A>', '<AUTH_USER_ID_FROM_2B>', 'agency_admin');
```

That is it — sign in (or refresh) and your token carries
`user_role = agency_admin` + your `tenant_id`. You can now create clients and add
users (operators, client-viewers) from inside the app.

- **Add an operator:** create their auth user (step-2 prerequisite), then
  `insert into public.tenant_users (tenant_id, auth_user_id, role) values
  ('<TENANT_ID>', '<THEIR_AUTH_USER_ID>', 'operator');`
- **Add a client-viewer** (scoped to ONE client — never sees siblings):
  `insert into public.tenant_users (tenant_id, auth_user_id, role, client_id)
  values ('<TENANT_ID>', '<THEIR_AUTH_USER_ID>', 'client_viewer',
  '<THE_ONE_CLIENT_ID>');` — `client_id` is **required** for a viewer and the
  hook mints it into the token; the viewer can never influence it.

`platform_owner` is intentionally **not** a `tenant_users` role — it is internal
cross-tenant tooling that runs server-side under the service-role key, never a
per-tenant membership.

### Verifying it worked

After enabling + provisioning, decode a fresh access token (jwt.io, or log
`getClaims()` server-side) — it must contain `tenant_id` and your `user_role`
(the app role). The standard `role` claim will read `authenticated` — that is
PostgREST's DB-role claim, not the app role, and is expected. If `tenant_id` /
`user_role` are missing, the hook is not enabled (Step 1) or you have no
`tenant_users` row (Step 2c).

> ✅ **RESOLVED — reserved `role` claim vs. PostgREST (Orchestrator +
> Code Review, 2026-07-08).** Original problem: the frozen RLS read the *app*
> role from the JWT `role` claim, which is also PostgREST's *database-role*
> claim — so the moment a logged-in user ran a supabase-js data query, PostgREST
> would `SET ROLE <app role>` and fail (the app roles are not grantable Postgres
> roles). **Chosen resolution — Option 2:** the app role now travels in the
> **non-reserved `user_role` claim**. Migration 0008 re-points `app.user_role()`
> at `user_role`; the hook (migration 0007) mints the app role into `user_role`
> and **leaves GoTrue's `role = authenticated` untouched**. PostgREST therefore
> keeps `SET ROLE authenticated` — the request role every RLS policy targets and
> the full 399-test isolation suite exercises. **Rationale:** keeping the
> production request role as `authenticated` preserves exact test fidelity (no
> untested grantable app-role context in production) — the deciding factor over
> introducing member-of-`authenticated` app roles. No per-project role
> provisioning is required; the first logged-in data-querying slice is
> unblocked. See the migration-0007/0008 headers and
> `docs/contracts/data-model.md` §12.

### If claims are empty for EVERYONE after enabling the hook

The hook is `SECURITY DEFINER` and reads `tenant_users` as its owner
(`postgres`), which bypasses RLS in Supabase. If a self-hosted / non-standard
deployment runs migrations as a role **without** `BYPASSRLS`, the hook reads
nothing and mints no claims for anyone (a loud, safe failure — never a leak).
Fix by running migration 0007 as a `BYPASSRLS` role (e.g. `postgres`), or grant
the hook's owner `BYPASSRLS`. Do **not** "fix" it by adding an RLS policy that
exposes `tenant_users` to other roles.
