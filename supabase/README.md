# supabase/

Database project directory — the F1 multi-tenant data model (doc 03), built at
step 0.3 by the `lead-backend-data-architect`. Contract:
`docs/contracts/data-model.md` (Published, v1.0.0).

- `migrations/` — numbered SQL migrations (`0001_…` → `0006_…`), applied in
  filename order. Every tenant-owned table ships WITH its RLS policies
  (enabled **and forced**), grants, composite tenant-consistency FKs, and
  indexes in the same migration. The Backend agent authors; DevOps executes
  (staging first, prod after verification).
  **Migrations never create the `auth` schema** — `auth.jwt()` is
  Supabase-provided; the local test harness installs an exact shim.
- `tests/` — tenant-isolation harness + smoke suite (`npm run
  test:isolation`); see `tests/README.md`. The QA agent's adversarial
  isolation suite builds on `tests/helpers/`.
- Link local tooling: `npx supabase init && npx supabase link --project-ref
  <ref>` (per environment; see `docs/ops/environments.md` for the
  staging/prod project split).
