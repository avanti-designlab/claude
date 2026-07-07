---
name: aeo-audit
description: The AEO/SEO scoring rubric as a reusable check. Input is crawled site data + the loaded industry playbook; output is a scored, prioritized fix list with impact estimates. Used by the aeo-seo-logic-engineer (M2 Audit Engine, M4 competitor analysis) and content-quality (AEO-formatting checks). Use whenever a site or page needs scoring against the playbook rubric.
---

# aeo-audit

The AEO/SEO scoring rubric as a reusable check (docs 01 §6, 05 M2). Scores a crawled site against the loaded playbook and outputs a prioritized fix list with impact estimates — which feeds the plan generator (M1) and the auto-fix engine (doc 04).

## Inputs
- Crawled site data (pages, rendered DOM, robots.txt, schema blocks, internal links, media)
- The loaded playbook (vertical rubric weights, `schema_profile`, `local_module_config`, content templates)

## Checks (the rubric)
1. **Schema presence + validity** — the playbook's `schema_profile` types present, valid, and matching visible text.
2. **Direct-answer FAQ formatting** — FAQs open with the answer; correct AEO structure.
3. **Transcript + VideoObject on video pages** — every video page has an indexable transcript and VideoObject schema.
4. **llms.txt** — present and correct.
5. **AI-crawler access** — GPTBot / ClaudeBot / PerplexityBot / Google-Extended not blocked (robots.txt + response behavior); JS-render visibility (content visible without client-side JS).
6. **Internal-linking density** — orphan pages, hub/pillar link structure.
7. **Entity consistency** — names/NAP/credentials consistent across the site and known profiles.
8. **GBP completeness** — per the playbook's local intensity.
9. **NAP consistency** — across the playbook's directory list.
10. **Review velocity** — recency and rate per the vertical's expectations.
11. **Core Web Vitals** — pass/fail with the failing metric.
12. **Freshness/staleness** — pages past the playbook's refresh window, stale stats/dead facts.
13. **Title/meta/H1/alt coverage** — on-page basics complete and non-duplicative.

## Output
A scored result per check (with evidence), rolled into a prioritized fix list: each fix carries an impact estimate, an owning module (schema → M10, on-page → M13 auto-fix, content → M8, local → M14, …), and — where the fix is automatable — the `automation_level` it should carry (doc 03 §6).

## Weighting
Rubric weights follow the loaded playbook: `local_intensity` gates checks 8–10 (national/e-commerce → local checks off), and `channel_weighting` shifts fix priority toward where authority is actually built in that vertical.

## Used by
`aeo-seo-logic-engineer` (M2 audit, M4 competitor gap analysis), `content-quality` (AEO-formatting review).

## Status
Skill defined (Phase 0). The standalone, isolation-tested implementation (crawler adapters + rubric scorer at `src/lib/skills/aeo-audit/`) is built and QA-gated in build step 0.2 — this skill then wraps that library.
