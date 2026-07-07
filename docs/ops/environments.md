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
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Bypasses RLS — used ONLY for admin/migration tooling; never imported in client code; never used in tenant-facing request paths (doc 03 §2 `platform_owner` rule) |
| `SUPABASE_DB_URL` | tooling only | Direct Postgres connection for migrations |

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
