# supabase/

Database project directory. **Empty by design until build step 0.3** — the multi-tenant data model (doc 03) is F1, the hard-gated foundation, and does not start until the operator opens 0.3.

- `migrations/` — SQL migrations land here (Backend agent authors, DevOps executes: staging first, prod after verification). Every tenant-owned table ships WITH its RLS policies in the same migration.
- Link local tooling: `npx supabase init && npx supabase link --project-ref <ref>` (per environment; see `docs/ops/environments.md` for the staging/prod project split).
