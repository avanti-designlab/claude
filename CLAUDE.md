# AEO/GEO + Brand Production OS

AI-native agency operating system: AEO/GEO intelligence + brand-consistent AI production, driven by industry playbooks. **Multi-tenant and white-label-ready from commit one** — built multi-tenant, deployed single-tenant (our agency is tenant #1).

## Source of truth

The complete build brief lives in `docs/` (00–07 + README). **Read `docs/00-master-architecture-brief.md` first, always.** `docs/07-build-sequence-and-execution-checklist.md` is the execution order. `docs/BUILD-STATE.md` is the live task board — check it to know the current stage before doing anything.

## Governance (non-negotiable — enforced by lead-architect-orchestrator)

1. **Foundation gate:** NO feature work until F1 (data model, doc 03) and F2 (design system, doc 06) are built, reviewed, and FROZEN. Doc 07 marks the 🔒 freeze gates. Post-freeze changes require Orchestrator + Code Review sign-off.
2. **Tenant isolation is sacred:** every table, query, and API route is tenant-scoped; RLS at the database level. One tenant reading another's data = automatic Code Review rejection.
3. **Nothing is "done" until it passes its named review gate** (doc 07 names the gate per block): code → `code-review`; product-generated content → `content-quality` AND `compliance-review`; on-page/site writes → diff preview + human approval + rollback verified by `qa-testing`; UI → `lead-ui-ux-designer` design review. The F2 design-system freeze additionally requires **operator sign-off** (no foundation gate reviews itself).
4. **No silent auto-fix:** every client-site write goes through the change-management layer (change-log, diff preview, one-click rollback, auto-rollback). No exceptions.
5. **AI drafts, humans approve:** fully autonomous publishing is prohibited for content and on-page changes (`automation_level` flag, doc 03 §6).
6. **Compliance gate per vertical:** nothing ships without passing the loaded vertical's `compliance-ruleset`.
7. **Escalate, don't improvise:** when docs 00–07 are silent or contradictory, escalate to the human operator. Never invent architecture.
8. **One owning agent per task.** The Orchestrator sequences; the Documentation agent keeps contracts/docs current; agents read docs before building.
9. **Local prototype before any live hosting (operator standing rule, 2026-07-07):** nothing is deployed to a live/hosted environment (Vercel preview, staging, or prod) until the operator has first reviewed a local prototype build (`npm run dev`, screenshots, or a local walkthrough). Local first, always; hosting only on explicit operator approval.

## Agent team (.claude/agents/) & skills (.claude/skills/)

Orchestration: `lead-architect-orchestrator` (sole authority to advance stages). Build: `lead-ui-ux-designer`, `lead-backend-data-architect`, `frontend-engineer`, `integrations-engineer`, `aeo-seo-logic-engineer`, `content-production-engineer` (generates content, never approves its own output). Quality (veto power): `code-review`, `content-quality`, `compliance-review`. Ops: `qa-testing`, `devops-deployment`, `documentation`.

Skills: `schema-generation`, `brand-kit-design-token`, `compliance-ruleset`, `aeo-audit`. Logic lives in skills, not buried in agents; each is tested in isolation (build step 0.2).

## Stack

Next.js (App Router, TypeScript, Tailwind v4) at repo root · Supabase (Postgres + RLS + Auth) · Vercel (staging + prod) · Cloudflare Workers (`workers/edge-autofix/`, edge auto-fix method) · shadcn/ui (F2, not yet installed) · Recharts · Anthropic API. Environment/secrets runbook: `docs/ops/environments.md`.

## Commands

- `npm run dev` / `npm run build` / `npm run start`
- `npm run lint` · `npm run typecheck`

## Repo layout notes

- `carousel-studio/` is a pre-existing, unrelated project — do not touch it as part of platform work.
- `src/` is the platform app. `supabase/` holds config + migrations (empty until F1 work is approved). `workers/` holds the Cloudflare edge-worker scaffold (built out in Phase 1.3).
