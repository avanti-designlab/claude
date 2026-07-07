# AEO/GEO + Brand Production OS — Master Build Brief
### Handoff document set for Claude Code

This is the complete build brief for an **AI-native agency operating system**: AEO/GEO intelligence fused with brand-consistent AI production, driven by industry-specific playbooks, built multi-tenant and white-label-ready.

## How to use this with Claude Code

1. **Start with `00`** — it's the spine. Keep it as always-loaded context.
2. **Operationalize `01` before any feature work** — set up the agent team and the four skills, and enforce the foundation-first governance gate.
3. **`02`–`06` are domain specs** — each agent loads the doc relevant to its task.
4. **Foundation first:** the Backend agent builds the data model (`03`) and the Designer builds the design system (`06`); both are reviewed and **frozen** before feature agents start. This is the #1 rule.

## Document index

| # | Document | What it covers |
|---|---|---|
| 00 | **Master Architecture Brief** | Vision, positioning, stack, full module map, build phases, governance rules |
| 01 | **Agent Team & Skills Config** | Claude Code subagent definitions, 4 reusable skills, review gates, orchestration |
| 02 | **Industry Playbooks** | All five verticals written in full (cannabis, real estate, restaurants, health & life insurance, e-commerce) |
| 03 | **Data Model & Multi-Tenancy** | Tenant-isolated schema, Supabase RLS, roles, white-label foundation, automation-level flag |
| 04 | **Auto-Fix & Integrations Engine** | 4 connection methods (WordPress/Webflow/Wix APIs + Cloudflare edge worker), unified rollback layer, all external connectors |
| 05 | **Content Pipeline, Intelligence & Resource Center** | Audit/tracker/competitor-RE/crawler/freshness, brand production, humanization+authenticity gate, blog writing, local/reviews, ROI/alerts, Claude resource center |
| 06 | **Design System & UI Spec** | shadcn/Tailwind foundation, Recharts, Aceternity/Magic UI moments, white-label theming, key screens |
| 07 | **Build Sequence & Execution Checklist** | Task-by-task build order Phase 0 → Phase 2, freeze gates, per-block owner + review gate, what parallelizes — the timeline the Orchestrator drives from |

## The core idea in one paragraph

Select a client's vertical at onboarding → the **Industry Playbook** loads and auto-generates a custom AEO/SEO/GEO/local plan → the **audit engine** scores the site → the **brand-consistent production engine** generates humanized, compliant, on-brand content and schema → the **auto-fix engine** publishes it directly to the client's site (WordPress/Webflow/Wix via API, Framer via edge worker) with full rollback safety → the **visibility tracker** measures whether AI citation and rankings moved → **competitor reverse-engineering** feeds the next plan. Built multi-tenant and white-label from day one so it runs the operator's own agency first, then licenses to other agencies.

## Phasing at a glance

- **Phase 0 (gated):** multi-tenant data model + design system + agent team + skills. Frozen before features.
- **Phase 1 (core):** playbook engine (5 seed verticals + on-demand playbook generator), full intelligence suite, brand production + humanization, blog writing, auto-fix (4 methods), local + reviews, social + PR entity-leverage, ROI + alerting, resource center, white-label client dashboard.
  - **Validation-first rollout:** prove the entire loop on **one vertical, one client** (real estate / GG as client zero) at Gate 1a, *then* fan out to the other verticals and activate on-demand playbook generation for any industry.
- **Phase 2:** Git/PR auto-fix for coded sites, paid ads module, CRM integration, external-agency white-label onboarding.

## Ready for any industry

The five seed playbooks (cannabis, real estate, restaurants, insurance, e-commerce) are hand-authored and proven first. The **Playbook Generator** then lets you onboard a client in *any* industry on demand — it researches the niche and drafts a complete playbook (prompts, schema, channels, compliance) that a human approves before live use. Build for all industries from day one; roll out one controlled client first, then open the doors.

## Non-negotiables (carried across all docs)

- Multi-tenant isolation enforced at the database (RLS), not just the app.
- No write to a client site bypasses the change-log / diff-preview / rollback layer.
- Every generative output passes content-quality + compliance review before publish.
- Content is generated in brand voice, humanized, and detection-checked — authenticity protects clients from penalties.
- AI drafts, humans approve. Foundation first, then parallelize.
