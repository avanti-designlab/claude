# 05 — Content Pipeline, Intelligence & Resource Center
### The AEO logic, the brand-consistent production engine, the humanization/authenticity gate, and the industry resource center

> **Purpose.** Defines the intelligence modules (audit, tracker, competitor reverse-engineering, crawler monitoring, freshness), the production pipeline (blog/content, schema, social, PR entity-leverage), the humanization + authenticity gate, the local/reviews modules, measurement (ROI + alerting), and the Claude-powered industry resource center. Primary agents: `aeo-seo-logic-engineer` (intelligence) and `content-production-engineer` (production — added by operator resolution 2026-07-07), gated by `content-quality` and `compliance-review`.

---

## PART A — INTELLIGENCE MODULES (the moat logic)

### M2 — On-page + technical Audit Engine
Crawl a client property; score against the loaded playbook via the `aeo-audit` skill. Outputs a prioritized fix list with impact estimates → feeds the plan (M1) and the auto-fix engine (doc 04).

**Rubric (from `aeo-audit`):** schema presence + validity, direct-answer FAQ formatting, transcript + VideoObject on video pages, llms.txt, AI-crawler access, internal-linking density, entity consistency, GBP completeness, NAP consistency, review velocity, Core Web Vitals, freshness/staleness, title/meta/H1/alt coverage.

### M3 — AI Visibility Tracker (AEO/GEO)
Run the playbook's prompt library across ChatGPT, Perplexity, Gemini, Claude, Copilot, Google AI Overviews on a schedule. Log per result: cited/not, position, sentiment, the source cited instead. **History matters** — citation churn is high (40–60% of cited domains change monthly), so a single snapshot is noise; the trend line is the product. Store every run (`visibility_results`, doc 03).

**Testing loop:** named target prompts (seeded from the playbook, expanded per client) → monthly (or weekly) run → gaps feed the content roadmap. This loop IS the strategy, not a checkbox.

### M4 — Competitor citation reverse-engineering
When a competitor is cited for a target prompt and the client isn't, analyze **why**: their schema, content structure, the third-party sources feeding the model, entity signals. Output the specific gap-closing task ("they win because X; do Y"). This "here's exactly why they won and here's the fix" loop is the highest-value capability in the category — most tools stop at "you're not cited."

### M5 — AI crawler + render-visibility monitoring
Detect the technical half of "why am I not cited": robots.txt blocks of GPTBot / ClaudeBot / PerplexityBot / Google-Extended, and JS-render invisibility (crawler sees an empty page). A page uncited past ~37 days usually has exactly this kind of block. Auto-flag → task → (often) an auto-fix via doc 04.

### M6 — Content decay / freshness engine
Flag pages past their refresh window (per playbook cadence, e.g. real-estate 60–90 days), detect stale stats/dead facts, queue refreshes. On refresh, update `dateModified` **only where real edits were made** — cosmetic date-bumping is discounted by Google and is prohibited.

---

## PART B — PRODUCTION PIPELINE (the brand-consistent engine)

### M7 — Brand Kit engine
Ingest a client brand once (logo, palette, typography, voice samples, product/founder likeness via Higgsfield/Motion reference elements) into a **locked, enforceable brand kit** (`brand_kits`, doc 03) via the `brand-kit-design-token` skill. Everything produced downstream is forced through this kit so all assets look like the same brand. This same kit powers white-label theming.

### The content pipeline (the mandatory path for ALL generated content)

```
1. GENERATE in brand voice
   - Anthropic API (Claude) generates in the client's locked voice profile from the START.
   - Generic-AI output is prevented at generation time, not just patched after — this is
     what actually avoids flagging, more than any post-processor.
   - Mapped to the playbook structure (pillar/keyword/FAQ) and AEO-formatted
     (direct-answer opening, correct structure).
        ↓
2. HUMANIZE  (M9 — authenticity gate, part 1)
   - Pass through the humanizer API to increase natural, authentic phrasing.
        ↓
3. DETECTION CHECK  (M9 — authenticity gate, part 2)
   - Score via the AI-detection API. Below threshold → back to humanize/revise.
   - This is a HARD gate: nothing reaches the publish queue as machine-flagged content.
        ↓
4. CONTENT QUALITY REVIEW  (content-quality agent)
   - On-brand? Substantive and genuinely useful (Google penalizes UNHELPFUL content,
     not "AI" per se)? Correct AEO formatting? Not generic?
        ↓
5. COMPLIANCE REVIEW  (compliance-review agent)
   - Passes the loaded vertical's compliance-ruleset skill? (cannabis/insurance/health/etc.)
        ↓
6. SCHEMA  (M10)
   - Generate matching JSON-LD via schema-generation skill (must match visible text).
        ↓
7. PUBLISH  (via auto-fix engine, doc 04)
   - Diff preview → human approve (ai_draft_human_approve) → write → change-logged → reversible.
```

> **Why the humanization layer is a real differentiator, stated honestly for the eventual sales story:** authenticity that protects against penalties comes from *substance + brand voice + natural phrasing together*, not from defeating a detector alone. The module does both — it makes content read human AND enforces genuine usefulness. That combination is the selling point, and it's what keeps clients from getting penalized.

### M8 — Content Production module (blogs + articles + FAQ + pillars)
First-class module. Generates full blog posts/articles mapped to the playbook's pillar/keyword/FAQ plan, in the locked brand voice, through the full pipeline above. Also: FAQ rewrites into direct-answer format, pillar refreshes (with M6), and the resource-center/FAQ-video page pattern (indexable text page + transcript + VideoObject schema).

### M9 — Humanization + authenticity gate
As embedded in the pipeline (steps 2–3). Owns the humanizer + AI-detection integrations and the revise loop. Stores results on `content_items.humanization` (doc 03).

### M10 — Schema generation
Via the `schema-generation` skill. Every playbook type. Schema must match visible page text exactly (mismatch = manual-action risk). Person schema aggregates all known press/profiles into `sameAs` for entity resolution.

### M11 — Social design + scheduling + captions
Brand-consistent creative via Higgsfield/Motion (forced through the brand kit) + caption generation (through the content pipeline incl. humanization + compliance) + auto-scheduling via the Ayrshare-class API. **Cross-feed advantage:** AEO assets become social — FAQ videos → Shorts/Reels, pillar content → carousels — all from the same brand engine. Scheduling plumbing is rented; the design + captions are where unique value lives.

### M12 — PR entity-leverage
Automate the **leverage-what-exists** half: build the Press / "As Featured In" section, generate the Person `sameAs` array from the client's known citations, insert on-page publication mentions ("As featured in [Publication]…"). **New-PR outreach stays human-assisted** (a drafting tool, not auto-fired) — automated cold outreach reads as spam and damages authority, the opposite of the goal.

---

## PART C — LOCAL & REPUTATION

### M14 — Local SEO module
GBP management, NAP consistency auditing across the playbook's directory list, local-pack rank tracking by ZIP, local schema, **multi-location support** (per-location GBP + pages for restaurant groups / dispensary chains / insurance offices). Intensity set by the playbook's `local_intensity` (CRITICAL for restaurants/cannabis, MEDIUM for real-estate/insurance, OFF for e-commerce).

### M15 — Review management
Monitor reviews across Google/Yelp/TripAdvisor/Trustpilot/BBB (where APIs allow), draft on-brand responses (through the content pipeline), sentiment tracking, velocity alerts (feeds M17). Critical for local verticals; feeds local rankings.

---

## PART D — MEASUREMENT

### M16 — ROI / attribution layer
Tie AI visibility + rankings to actual outcomes: GA4 sessions, call-tracking, form fills, CRM handoff. Answers "did this make money," which is what clients pay for and what makes agencies retain the tool. This is also the pricing justification when licensing to agencies.

### M17 — Alerting engine
Real-time flags: visibility dropped, competitor overtook, schema broke, crawler blocked, negative-review spike, site down, auto-rollback fired. Turns the platform from a thing people check into a thing that tells them when to act. Writes `alerts` (doc 03); surfaced in dashboards + notifications.

---

## PART E — INDUSTRY RESOURCE CENTER

### M18 — Claude-powered, playbook-scoped Q&A assistant
An embedded assistant (Anthropic API + web search enabled) that operators or clients query for **industry-specific** questions — regulations, market data, "what are people asking AI about [vertical] this month," compliance questions, content research. Scoped by the loaded playbook so answers are vertical-aware.

**Doubles as infrastructure:**
- Feeds the **prompt-volume intelligence** for M3 (which prompts actually have volume in the niche).
- Feeds **content research** for M8 (topic/FAQ discovery, PAA expansion).
- Feeds **compliance questions** to support the Compliance Review agent's rulesets.
- **Powers the Playbook Generator (M1b, doc 02 §2.6)** — the same Claude + web-search stack researches a brand-new industry and drafts a full playbook on demand, so any client in any industry can be onboarded (draft → human + Compliance approval → live).

**Implementation notes:** built on the Anthropic API with web search; retrieval scoped to the client's vertical + (optionally) the client's own content; results are research aids for humans, not auto-published content (auto-published content still goes through the full pipeline).

---

## Module → agent → skill map (quick reference)

| Module | Owning agent | Skills | Gates |
|---|---|---|---|
| M2 Audit | aeo-seo-logic-engineer | aeo-audit | code-review |
| M3 Tracker | aeo-seo-logic-engineer | — | code-review |
| M4 Competitor RE | aeo-seo-logic-engineer | aeo-audit | code-review |
| M5 Crawler monitor | aeo-seo-logic-engineer | — | code-review |
| M6 Freshness | aeo-seo-logic-engineer | — | code-review |
| M7 Brand Kit | lead-ui-ux-designer + content-production-engineer | brand-kit-design-token | design-review |
| M8 Content | content-production-engineer | aeo-audit | content-quality + compliance-review |
| M9 Humanization | content-production-engineer + integrations | — | content-quality (hard gate) |
| M10 Schema | aeo-seo-logic-engineer | schema-generation | code-review |
| M11 Social | content-production-engineer + integrations | brand-kit-design-token | content-quality + compliance-review |
| M12 PR entity | content-production-engineer | schema-generation | content-quality |
| M14 Local | aeo-seo-logic-engineer + integrations | schema-generation | code-review |
| M15 Reviews | content-production-engineer + integrations | — | content-quality + compliance-review |
| M16 ROI | integrations | — | code-review |
| M17 Alerts | aeo-seo-logic-engineer + devops | — | code-review |
| M18 Resource Center | integrations + aeo-seo-logic-engineer | compliance-ruleset | content-quality |
