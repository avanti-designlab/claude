# 00 — Master Architecture Brief
### Project codename: **The AEO/GEO + Brand Production OS** (working name — rename at build time)

> **Purpose of this document.** This is the spine. It defines the vision, the system architecture, the technology stack, the full module map, the build phases, and the governance rules that every agent and every sub-document must obey. The other six documents (01–06) go deep on specific domains. Read this first, then load the sub-document relevant to the task at hand.

> **How to use this document set in Claude Code.** Treat `00` as always-loaded context. `01` defines the agent team and skills and should be operationalized before any feature work begins. `02`–`06` are domain specs loaded by the agent working that domain. The **Lead Architect / Orchestrator** agent owns the sequencing and enforces the governance gates defined at the end of this document.

---

## 1. Vision & positioning

We are building an **AI-native agency operating system** whose defensible core is the fusion of two things almost no competitor combines:

1. **AEO/GEO intelligence** — getting clients cited and surfaced by AI answer engines (ChatGPT, Perplexity, Gemini, Claude, Copilot, Google AI Overviews) and ranking in traditional + local search, driven by **industry-specific playbooks** that auto-generate a custom plan the moment a client's vertical is selected.
2. **Brand-consistent AI production** — generating on-brand, humanized, compliant content and creative (blogs, schema, social, video/image assets) at volume, forced through a locked per-client brand system so everything ships looking like the same brand.

**Why this wins.** The AEO-native tools on the market are single-purpose dashboards with weak content generation. The all-in-one agency platforms (GoHighLevel, Vendasta, DashClicks) are wide but have no real AEO engine and no industry-playbook auto-planning. **Nobody owns the intersection: AEO-first + industry-aware + brand-consistent production + agency-operated.** That intersection is the wedge.

**The loop that makes it more than "another AEO tool":**
```
Playbook selects target prompts + content plan for the vertical
        ↓
Brand engine produces the content/assets on-brand + humanized
        ↓
Auto-fix engine publishes to the client site (schema, on-page, blogs)
        ↓
Visibility tracker measures whether AI citation / rankings moved
        ↓
Competitor reverse-engineering + gap analysis feed the next plan
        ↺  (loop)
```

## 2. Strategic constraints (these shape every build decision)

- **Build multi-tenant, deploy single-tenant.** The platform runs our own agency (client zero) first, but the data model, roles, and theming are multi-tenant and white-label-ready from commit one. The destination is licensing to other agencies. Never write code that assumes a single tenant.
- **Own the intelligence + production; rent the commodity plumbing.** We build the AEO logic, playbooks, brand engine, and auto-fix. We integrate (not rebuild) social posting (Ayrshare-class API), analytics (GA4), and — later — CRM (GoHighLevel-class) and ad platforms. Do not rebuild a CRM or an email/SMS suite.
- **AI drafts, humans approve.** Every generative output passes a review gate before it touches a live client site. The human-in-the-loop is a feature, not a bottleneck (the operator has a 30-person team). Fully autonomous publishing is prohibited for content and on-page changes.
- **Authenticity is the product.** Content is generated in real brand voice, humanized, and detection-checked before publish. We protect clients from penalties. Substance + brand voice + humanization together — not detector-gaming alone.
- **Compliance is a liability gate, not a feature.** Cannabis, health, and insurance verticals carry legal constraints. Generated content and any future ads tooling must pass a per-vertical compliance gate.
- **Foundation first, then parallelize.** The data model and design system are built, reviewed, and frozen before feature agents build on them. This is the single most important governance rule (see §7).
- **Prove one vertical end-to-end before scaling to all.** All five playbooks exist in the architecture from day one, but Phase 1 validates the entire loop (onboard → plan → produce → publish → track → report) on **one vertical, one client** first — real estate, using GG as client zero — before the other verticals are switched into active client use. Validating on one controlled client surfaces real-world rough edges faster than spreading across five at once. See doc 07 for where this gate sits.

## 3. Technology stack

| Layer | Choice | Rationale |
|---|---|---|
| Framework | **Next.js (App Router)** | Team knows it; SSR/edge-friendly; multi-tenant routing |
| Database + Auth | **Supabase (Postgres + RLS + Auth)** | Row-Level Security is the backbone of tenant isolation; built-in auth/roles |
| Hosting / Edge | **Vercel** + **Cloudflare Workers** (for the edge-worker auto-fix method) | Vercel for the app; CF Workers for site-delivery rewriting |
| UI foundation | **shadcn/ui + Tailwind CSS** | Modern SaaS standard; fully themeable → white-label |
| Charts | **Recharts** | Analytics/visibility dashboards |
| High-impact animation | **Aceternity UI + Magic UI** | Reserved for defined "moments" only (see doc 06) |
| In-product AI | **Anthropic API (Claude)** | Content generation, resource center, plan generation |
| In-product media | **Higgsfield + Motion (MCP)** | Video/image/voice asset production inside the product |
| Social posting | **Ayrshare-class API** | Rent the posting plumbing; do not build native platform integrations |
| Humanization | **Humanizer API + AI-detection API** | Authenticity gate (see doc 05) |

> **Note on connectors:** Higgsfield and Motion are the **in-product content production engine** — they generate client assets. They are NOT used to style the app's own UI. The app's interface quality comes from the design system in doc 06.

## 4. Module map (all Phase 1 core unless marked)

**Foundation**
- **F1. Multi-tenancy & white-label core** — tenant isolation (Supabase RLS), role-based access, themeable client dashboards. *(Doc 03)*
- **F2. Design system** — shadcn/Tailwind tokens, theming engine, component library. *(Doc 06)*

**Onboarding & planning**
- **M1. Industry Playbook Engine** — select vertical + location(s) + connect properties → auto-generate custom AEO/SEO/GEO/local plan + task roadmap. Includes a **Playbook Generator (M1b)** so any industry can be onboarded on demand, not just the seed five. *(Docs 02, 05)*

**Intelligence (the moat logic)**
- **M2. On-page + technical Audit Engine** — crawl client site, score against playbook rubric. *(Doc 05)*
- **M3. AI Visibility Tracker (AEO/GEO)** — run playbook prompt library across all engines, log cited/not, position, sentiment, source, competitor. *(Doc 05)*
- **M4. Competitor citation reverse-engineering** — when a competitor is cited and client isn't, analyze why + generate the gap-closing task. *(Doc 05)*
- **M5. AI crawler + render-visibility monitoring** — detect GPTBot/ClaudeBot/PerplexityBot/Google-Extended blocks and JS-render invisibility. *(Doc 05)*
- **M6. Content decay / freshness engine** — flag pages past refresh window, stale stats; queue refreshes with dateModified. *(Doc 05)*

**Production (the brand engine)**
- **M7. Brand Kit engine** — ingest a client brand once (logo, palette, type, voice, product/founder likeness) into a locked, enforceable kit. *(Docs 05, 06)*
- **M8. Content Production module** — blog/article writing + FAQ rewrites + pillar content, mapped to playbook, in brand voice. *(Doc 05)*
- **M9. Humanization + authenticity gate** — brand-voice generation → humanization pass → AI-detection check → revise loop. *(Doc 05)*
- **M10. Schema generation** — JSON-LD for every playbook type (FAQPage, Article, Person+sameAs, VideoObject, LocalBusiness, Product, etc.). *(Doc 05, Skill)*
- **M11. Social design + scheduling + captions** — brand-consistent creative (via Higgsfield/Motion) + captions + auto-schedule (via Ayrshare-class API). *(Docs 05, 06)*
- **M12. PR entity-leverage** — turn a client's existing press into entity signals (Press section, Person sameAs, on-page mentions). New-PR outreach stays human-assisted. *(Doc 05)*

**Execution (writing to client sites)**
- **M13. Auto-Fix & Integrations Engine** — 4 connection methods (WordPress, Webflow, Wix APIs + Cloudflare edge worker) with a single unified change-log / diff-preview / one-click-rollback / auto-rollback layer. Git/PR method architected now, built as coded-sites arrive. *(Doc 04)*

**Local & reputation**
- **M14. Local SEO module** — GBP management, NAP consistency across directories, local-pack rank tracking by ZIP, local schema, multi-location support. *(Doc 05)*
- **M15. Review management** — monitor + draft responses across Google/Yelp/industry platforms, sentiment + velocity alerts. *(Doc 05)*

**Measurement & knowledge**
- **M16. ROI / attribution layer** — tie visibility + rankings to leads/revenue (GA4, call tracking, form fills, CRM handoff). *(Doc 05)*
- **M17. Alerting engine** — real-time flags: visibility drop, competitor overtook, schema broke, crawler blocked, negative review spike, site down. *(Doc 05)*
- **M18. Industry Resource Center** — Claude-powered, playbook-scoped Q&A assistant (Anthropic API + web search) for vertical research, compliance questions, prompt-volume intelligence. *(Doc 05)*

**Client-facing**
- **M19. White-label client dashboard** — per-client visibility score over time, share-of-voice vs competitors, local rankings, **work-done log**, content calendar, ROI. *(Docs 03, 06)*

**Phase 2 (architected now, built later)**
- **P2-A. Git/PR auto-fix method** — for Next.js / coded / dev-managed sites.
- **P2-B. Paid ads module** — Meta/Google campaign creation + management (operator already runs a paid-ads team; compliance-gated per vertical).
- **P2-C. CRM/email/SMS integration** — integrate GoHighLevel-class, do not rebuild.

## 5. Build phases

**Phase 0 — Foundation (gated, must complete & freeze before Phase 1 features)**
- F1 multi-tenancy + RLS data model (Doc 03) — built and security-reviewed
- F2 design system + theming tokens (Doc 06) — built and design-reviewed
- The 4 reusable skills defined (Doc 01)
- The agent team configured (Doc 01)

**Phase 1 — Core product (everything above not marked Phase 2)**
- Build order within Phase 1: M1 playbook engine → M2/M3/M5 intelligence → M7/M8/M9/M10 production+humanization → M13 auto-fix (WordPress → Webflow → Wix → edge worker) → M4/M6 → M14/M15 local+reviews → M11/M12 social+PR → M16/M17 measurement → M18 resource center → M19 client dashboard.
- Modules are **independent modules behind a shared data layer** — if one lags it does not block others shipping.

**Phase 2 — Productize & expand**
- Git/PR auto-fix, paid ads module, CRM integration, deeper white-label onboarding for external agencies.

## 6. The five verticals (full playbooks in Doc 02)
Cannabis · Real estate · Restaurants/food/cafes · Health & life insurance · E-commerce.
Chosen to stress-test the full local-SEO-intensity range: hyper-local (cannabis, restaurants), semi-local (insurance, real estate), national (e-commerce).

## 7. Governance rules (the Orchestrator enforces these)

1. **Foundation gate.** No feature agent builds until F1 (data model) and F2 (design system) are built, reviewed, and frozen. Violating this is the #1 cause of multi-agent rework.
2. **Tenant-isolation is sacred.** Every table, query, and API route is tenant-scoped. The Code Review agent rejects any code path where one tenant could read another's data. This is a hard security gate, not a preference.
3. **Every generative output passes review before publish.** Content → Content Quality agent + Compliance Review agent. Code → Code Review agent. On-page changes → diff preview + human approve.
4. **No silent auto-fix.** Every write to a client site produces a change-log entry, a diff, and a one-click rollback. Auto-rollback triggers on correlated traffic/ranking drops.
5. **Shared source-of-truth docs stay current.** The Documentation agent updates the architecture doc, data model, and API contracts as they evolve. Agents read these before building. Drift = failure.
6. **Skills are reusable and tested in isolation** (schema-gen, brand-kit/tokens, compliance-ruleset, AEO-audit). Logic lives in skills, not buried in agents.
7. **Compliance gate per vertical.** No content or ads output ships without passing the loaded vertical's compliance ruleset.

## 8. Document index
- **00** — This master brief
- **01** — Agent Team & Skills Config (Claude Code subagents + skills + review gates)
- **02** — Industry Playbooks (all five verticals, full)
- **03** — Data Model & Multi-Tenancy
- **04** — Auto-Fix & Integrations Engine
- **05** — Content Pipeline, Intelligence & Resource Center
- **06** — Design System & UI Spec
