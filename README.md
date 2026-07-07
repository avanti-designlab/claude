# AEO/GEO + Brand Production OS

AI-native agency operating system: **AEO/GEO intelligence** (AI-answer-engine citation tracking, audits, competitor reverse-engineering) fused with **brand-consistent AI production** (on-brand, humanized, compliant content at volume), driven by industry playbooks. Multi-tenant and white-label-ready from commit one.

## Orientation

- **`docs/`** — the complete build brief (00–07). `docs/00-master-architecture-brief.md` is the spine; `docs/07-build-sequence-and-execution-checklist.md` is the execution order; `docs/BUILD-STATE.md` is the live task board (current stage lives there).
- **`CLAUDE.md`** — governance rules every agent obeys (foundation freeze gates, review gates, tenant isolation, escalation).
- **`.claude/agents/`** — the 12-agent build team (orchestrator, 5 build, 3 quality, 3 ops). **`.claude/skills/`** — the 4 reusable skills.
- **`src/`** — the Next.js (App Router) platform app. **`supabase/`** — DB config + migrations (empty until F1 opens). **`workers/edge-autofix/`** — Cloudflare edge-worker scaffold (Phase 1.3).
- **`docs/ops/environments.md`** — staging/prod topology, secrets, one-time provisioning runbook.
- **`carousel-studio/`** — pre-existing, unrelated project; not part of the platform.

## Development

```sh
cp .env.example .env.local   # fill in Supabase values (docs/ops/environments.md)
npm install
npm run dev
```

Checks: `npm run lint` · `npm run typecheck` · `npm run build` (CI runs all three on every PR).

## Status

**Phase 0, step 0.1 (project scaffold) complete.** Steps 0.2 (skills implementation), 0.3 (multi-tenant data model — F1), and 0.4 (design system — F2) are gated pending operator go-ahead. No feature work until both foundations are reviewed and frozen (🔒 Freeze Gate 0).
