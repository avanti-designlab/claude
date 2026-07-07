# supabase/tests — tenant-isolation harness + suites

Run with `npm run test:isolation` (vitest, `vitest.isolation.config.ts`, serial
execution). Requires a live Postgres reachable via a **superuser** connection:

- `ISOLATION_DATABASE_URL` — defaults to
  `postgresql://postgres:postgres@127.0.0.1:5432/isolation_test`.
- A missing database FAILS the suite loudly. It never skips (doc 03 §7 — this
  suite can never fail silently).
- CI runs this in the `isolation` job against a `postgres:16` service container
  (`.github/workflows/ci.yml`).

## How a run works (`helpers/harness.ts`)

1. Connect to `ISOLATION_DATABASE_URL`, idempotently create the cluster roles
   `authenticated` / `anon` (NOLOGIN — the Supabase request roles), then create
   a **fresh scratch database** (`isolation_run_*`) for this run.
2. Install the **auth shim** in the scratch database: `create schema auth` +
   `auth.jwt()` reading `request.jwt.claims` — byte-for-byte what Supabase
   provides. **Only the harness creates the auth schema; migrations never do**
   (in real environments it is Supabase-provided).
3. Apply every `supabase/migrations/*.sql` in filename order.
4. Tests run statements through `queryAs(client, role, claims, sql)` — claims
   into `request.jwt.claims`, `SET LOCAL ROLE`, execute, commit/rollback —
   exactly the PostgREST execution model. `expectQueryRejected(...)` asserts
   denials. The `admin` connection is superuser (bypasses RLS): seeding and
   catalog assertions only.
5. `teardown()` drops the scratch database (`with (force)`).

## Files

- `helpers/harness.ts` — scratch-db lifecycle, roles, auth shim, migration
  runner, `queryAs`/`claimsFor`/`expectQueryRejected`, table lists
  (`ALL_TABLES`, `TENANT_ID_TABLES`, `CLIENT_SCOPED_TABLES`).
- `helpers/seed.ts` — two fully-populated tenants (every table seeded, plus a
  sibling client per tenant for client_viewer tests).
- `smoke.test.ts` — Backend agent's foundation smoke suite: migrations apply,
  RLS enabled+forced everywhere, tenant_id indexed everywhere, auth-shim
  round-trip, cross-tenant canaries.

## For the QA agent (0.3 isolation suite)

Build the adversarial suite on these helpers — `setupIsolationDb()` +
`seedTenantPair()` + `queryAs()` give you every role x every table x
read/write. The freeze bar (doc 03 §7): no cross-tenant read/write under ANY
role; `client_viewer` read-only and blind to sibling clients. The claim shapes
live in `src/lib/types/db.ts` (`JwtClaims`, `claimsFor`).
