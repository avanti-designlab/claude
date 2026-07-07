# 07 — Build Sequence & Execution Checklist
### The task-by-task order Claude Code works through, with freeze gates

> **Purpose.** This is the execution timeline the `lead-architect-orchestrator` drives from. It sequences the entire build from Phase 0 through Phase 2, marks the hard freeze gates, names the owning agent and review gate for each block, and calls out what can run in parallel. Work top to bottom; do not cross a **🔒 FREEZE GATE** until every item above it passes its review.

> **How to read it.** Each block = owning agent · what "done" means · review gate. `∥` marks work that can run in parallel once its dependencies are met. A gate line means: stop, verify, get sign-off, then proceed.

---

## PHASE 0 — FOUNDATION (gated — blocks everything)

### 0.1 — Project scaffold
- **Owner:** DevOps · **Gate:** Code Review
- Next.js (App Router) + Supabase + Vercel project stood up; CI/CD; staging + prod environments; secrets vault wired.
- Cloudflare Workers account/route provisioning ready (for later edge-worker method).

### 0.2 — Skills defined & tested in isolation ∥ (can run alongside 0.3/0.4)
- **Owner:** relevant build agents · **Gate:** Code Review + QA
- [ ] `schema-generation` skill — produces valid JSON-LD for every playbook type; tested standalone.
- [ ] `brand-kit-design-token` skill — brand assets → tokens + voice profile; tested standalone.
- [ ] `compliance-ruleset` skill — all five verticals' rules; tested standalone.
- [ ] `aeo-audit` skill — the scoring rubric; tested standalone.

### 0.3 — Multi-tenant data model (THE critical foundation)
- **Owner:** Lead Backend/Data Architect · **Gate:** Code Review (security + tenant isolation) + QA (isolation suite)
- [ ] Full schema (doc 03) with `tenant_id` on every tenant-owned table.
- [ ] RLS policies on every table; JWT carries tenant_id/role/client_id.
- [ ] Role model (platform_owner / agency_admin / operator / client_viewer).
- [ ] `automation_level` flag on tasks + generative actions.
- [ ] Secrets handling — no raw creds in tables.
- [ ] API contracts published by Documentation agent.
- [ ] **QA tenant-isolation suite passes: no cross-tenant read/write under ANY role; client_viewer cannot see sibling clients.**

### 0.4 — Design system + white-label theming ∥ (parallel with 0.3)
- **Owner:** Lead UI/UX Designer · **Gate:** Design Review + **operator sign-off** (F2 freeze requires the human operator as independent reviewer — operator resolution 2026-07-07)
- [ ] Token system (doc 06) — no hardcoded brand values anywhere.
- [ ] shadcn/ui + Tailwind component library.
- [ ] Recharts data-viz language.
- [ ] Theming engine — full re-skin via token swap proven; contrast validated per theme.
- [ ] The 5 defined animated moments (Aceternity/Magic UI), gated behind `prefers-reduced-motion`.

### 🔒 FREEZE GATE 0 — Foundation frozen
**Do not start Phase 1 until:** 0.3 passes security + isolation review AND 0.4 passes design review **+ operator sign-off** AND all 4 skills pass isolation tests. The Orchestrator records the freeze. Changes to frozen foundation now require Orchestrator + Code Review sign-off.

---

## PHASE 1 — CORE PRODUCT

> All modules build **behind the shared data layer** and are **independently shippable** — a lag in one does not block others. Within Phase 1, follow this order because later blocks consume earlier ones.

### 1.1 — Industry Playbook Engine (M1) — build first, everything reads it
- **Owner:** AEO/SEO Logic Engineer · **Gate:** Code Review + Content Quality (plan text)
- [ ] Playbook schema + all 5 seed verticals loaded (doc 02).
- [ ] Onboarding flow: industry select → location(s) → connect properties → generate plan.
- [ ] Plan generator: playbook + audit → prioritized, channel-weighted task roadmap.
- [ ] **Playbook Generator (M1b) built** (reuses M18 Claude + web-search stack) — but **not activated for live clients until after Gate 1a** (below). Generated playbooks are drafts requiring human + Compliance sign-off.
- **Rollout note:** all 5 seed playbooks exist in the system, but **only real estate is switched into active client use for the first validation pass** (see Gate 1a). The others stay loaded-but-dormant until the loop is proven.

### 1.2 — Integrations foundation: change-management layer FIRST
- **Owner:** Integrations Engineer · **Gate:** Code Review (rollback safety) + QA (rollback suite)
- [ ] **Unified change-management layer (build before ANY write method):** change-log + diff-preview + one-click-rollback + auto-rollback. Nothing writes to a client site except through this.
- [ ] Provider-agnostic connector interfaces (doc 04 §7): `CitationDataProvider`, `SocialPostingProvider`.

### 1.3 — Auto-fix write methods ∥ (after 1.2 exists)
- **Owner:** Integrations Engineer · **Gate:** Code Review + QA (rollback per method)
- [ ] WordPress API/plugin write + rollback  *(build first — highest coverage)*
- [ ] Webflow API write + rollback
- [ ] Wix API write + rollback
- [ ] Cloudflare edge worker write + rollback  *(covers Framer — required, not optional)*
- [ ] Property connection onboarding + platform detection.

### 1.4 — Intelligence suite ∥ (after 1.1; independent of 1.3)
- **Owner:** AEO/SEO Logic Engineer · **Gate:** Code Review (+ Content Quality where text generated)
- [ ] M2 Audit Engine (uses `aeo-audit`).
- [ ] M3 Visibility Tracker (via `CitationDataProvider` — buy/rent now, swappable).
- [ ] M5 Crawler + render-visibility monitoring.
- [ ] M4 Competitor citation reverse-engineering.
- [ ] M6 Content decay / freshness engine.

### 1.5 — Brand production + the authenticity pipeline
- **Owner:** content-production-engineer + Integrations · **Gate:** Content Quality + Compliance Review (hard gates)
- [ ] M7 Brand Kit engine (locked kits via `brand-kit-design-token`).
- [ ] M8 Content Production (blogs/articles/FAQ/pillars, mapped to playbook, in brand voice).
- [ ] M9 Humanization + AI-detection gate (pilot 2–3 vendors first; pluggable).
- [ ] M10 Schema generation (via skill; must match visible text).
- [ ] Full pipeline enforced: Generate → Humanize → Detect → Quality → Compliance → Schema → Publish (via 1.2/1.3).

### 1.6 — Local & reputation ∥
- **Owner:** AEO/SEO Logic + Integrations · **Gate:** Code Review + (reviews) Content Quality + Compliance
- [ ] M14 Local SEO (GBP, NAP, local-pack by ZIP, local schema, multi-location) — intensity per playbook.
- [ ] M15 Review management (monitor + draft responses + sentiment + velocity).

### 1.7 — Social & PR ∥
- **Owner:** content-production-engineer + Integrations · **Gate:** Content Quality + Compliance
- [ ] M11 Social design (Higgsfield/Motion, brand-forced) + captions + scheduling (via `SocialPostingProvider`).
- [ ] M12 PR entity-leverage (Press section, Person sameAs, on-page mentions; new-PR outreach human-assisted).

### 1.8 — Measurement ∥
- **Owner:** Integrations + AEO/SEO Logic + DevOps · **Gate:** Code Review
- [ ] M16 ROI / attribution (GA4, GSC, call tracking, form fills, CRM handoff).
- [ ] M17 Alerting engine (visibility drop, competitor overtook, schema broke, crawler blocked, review spike, site down, auto-rollback fired).

### 1.9 — Resource center
- **Owner:** Integrations + AEO/SEO Logic · **Gate:** Content Quality
- [ ] M18 Claude-powered, playbook-scoped Q&A (Anthropic API + web search); feeds prompt-volume + content research.

### 1.10 — Client-facing dashboard (consumes everything above)
- **Owner:** Frontend Engineer · **Gate:** Design Review + Code Review
- [ ] M19 White-label client dashboard: Visibility Score (signature animation), share-of-voice, local rankings, **work-done log**, content calendar, ROI. Renders in tenant theme.

### 🔒 GATE 1a — Single-vertical validation (the first real proof)
**Prove the ENTIRE loop on one vertical, one client before fanning out.** The core product is validated when: onboarding → plan → audit → produce → publish (with rollback) → track → report works **end-to-end for real estate, with GG as client zero.** Capture the first case-study metrics (citation lift, hours saved). Fix the real-world rough edges here — on a client you control — not across five verticals at once.

**Only after Gate 1a passes:**
- Switch the other seed verticals (cannabis, restaurants, insurance, e-commerce) into active client use, onboarding real clients per vertical.
- **Activate the Playbook Generator (M1b) for live clients** — now you can onboard any industry on demand, each generated playbook human + Compliance approved before live use.

### 🔒 GATE 1 — Phase 1 ships (full multi-vertical)
**Core product is fully live** when the validated loop runs across the seed verticals with real clients, the client dashboard is live, and on-demand playbook generation is enabled. Case-study metrics accumulating across verticals.

---

## PHASE 2 — PRODUCTIZE & EXPAND

### 2.1 — Coded-sites support
- [ ] Git/PR auto-fix method (for the operator's future Next.js / coded sites).

### 2.2 — Paid ads module (operator already runs a paid-ads team)
- [ ] Meta/Google ad creative (from brand engine) + campaign setup — **compliance-gated per vertical** (cannabis blocked on Meta; insurance Special Ad Category + TCPA).

### 2.3 — CRM integration
- [ ] Integrate GoHighLevel-class CRM/email/SMS — **integrate, do not rebuild.**

### 2.4 — External-agency white-label onboarding
- [ ] Second-tenant onboarding flow; per-agency theming/billing; usage metering; support/uptime posture for SaaS licensing.

---

## Standing rules the Orchestrator enforces every step
1. Nothing is "done" until it passes its named review gate.
2. No client-site write bypasses the change-management layer (1.2).
3. No generative output publishes without Content Quality + Compliance sign-off.
4. Frozen foundation changes require Orchestrator + Code Review sign-off.
5. Documentation agent keeps API contracts + data model + architecture doc current; agents read before building.
6. One owning agent per task; no duplicate work.
7. When docs 00–07 are silent or contradictory, escalate to the human operator — do not improvise architecture.

---

## Critical-path summary (the spine, in order)
```
scaffold → data model 🔒 + design system 🔒 + skills
   → playbook engine (5 seed loaded + generator built) → change-mgmt layer → write methods
   → intelligence suite → brand+humanization pipeline
   → local/reviews → social/PR → measurement → resource center → client dashboard
   → 🔒 GATE 1a: prove ONE vertical end-to-end (real estate / GG client zero)
   → fan out to other seed verticals + ACTIVATE playbook generator (any industry on demand)
   → 🔒 GATE 1 ships (full multi-vertical)
   → (P2) coded sites → ads → CRM → external white-label
```
Everything after the foundation freeze can parallelize across agents; the two 🔒 foundation freezes and the 🔒 1a single-vertical validation are the hard serial checkpoints. **Build for all industries from day one; roll out one client, one vertical first, then open the doors to any industry.**
