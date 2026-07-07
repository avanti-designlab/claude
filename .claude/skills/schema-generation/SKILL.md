---
name: schema-generation
description: Generate valid JSON-LD structured data for every schema type used across the industry playbooks (FAQPage, Article, Person+sameAs, VideoObject, Breadcrumb, Podcast, LocalBusiness, Restaurant+Menu, Product+Offer, RealEstateAgent, Organization). Use whenever a module needs schema markup for a client page — inputs are entity data + schema type + client brand context; output is a validated JSON-LD block ready for injection via the auto-fix engine.
---

# schema-generation

Generate valid JSON-LD for the schema types used across the industry playbooks (doc 02). Output is a validated JSON-LD block ready for injection via the auto-fix engine (doc 04).

## Inputs
- Entity data (the facts to encode: business info, FAQ pairs, article metadata, person profile, product data, menu, etc.)
- Schema type (from the covered list below)
- Client brand context (from the client's locked brand kit)

## Covered types
`FAQPage`, `Article`, `Person` (with `sameAs`), `VideoObject`, `BreadcrumbList`, `PodcastSeries`/`PodcastEpisode`, `LocalBusiness` (incl. `Store` for cannabis), `Restaurant` (+ `Menu` + `MenuItem`), `Product` (+ `Offer` + `AggregateRating` + `Review`), `RealEstateAgent`, `Organization` (incl. `InsuranceAgency`), `Service`, `ItemList` (category/best-of), `Event`.

The loaded playbook's `schema_profile` dictates which types matter for the vertical and in what priority order.

## Hard rules
1. **Schema must match the visible page text exactly.** A mismatch between structured data and rendered content is a manual-action risk — never encode claims, FAQs, or facts that do not appear on the page.
2. **`Person.sameAs` must aggregate ALL known press/profiles for entity resolution:** press articles, bylines, LinkedIn, YouTube, podcast profiles, credential registries (RERA/NAR/CIPS for real estate; NPN/state-license lookups for insurance). This is the highest-value entity signal.
3. Output must validate against schema.org (and pass Google Rich Results eligibility where a rich-result type exists). Emit a single `<script type="application/ld+json">` block per entity.
4. Every generated block is injected only via the auto-fix engine's change-management layer — never hand-pasted outside the audit trail.
5. Dates (`datePublished`, `dateModified`) reflect real events only — `dateModified` is bumped only when real edits were made (doc 05 M6 rule). Date fields are sanity-validated (order, no invention, future-date warning against an injectable `referenceDate`) but exempt from the visible-text match, since rendered dates ("July 12, 2026") cannot be deterministically matched to ISO values. *(Policy pending operator ratification — BUILD-STATE item 11.)*

## Output
A validated JSON-LD block + a note of which visible page elements it corresponds to (so Code Review / Content Quality can verify the match).

## Status
**Implemented** at `src/lib/skills/schema-generation/` (70 isolation tests; entry point `generateSchema`, ready/rejected discriminated result — a rejected result carries no script block and `serializeToScriptBlock` only compiles against ready results). Passed the 0.2 gate (Code Review + QA, remediated and re-verified 2026-07-07). This skill wraps that library — invoke it rather than re-deriving schema logic.
