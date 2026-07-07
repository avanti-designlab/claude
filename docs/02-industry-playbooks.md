# 02 — Industry Playbooks
### The five verticals, written in full — the moat

> **Purpose.** The Playbook Engine is the spine of the product. When a vertical is selected at onboarding, its playbook loads and drives everything downstream: which prompts the tracker tests, which schema to generate, where authority is built, what compliance rules gate output, what content structures to use, and how hard the local module runs. These playbooks encode real operator experience — they are the thing competitors can't copy.

> **How a playbook is consumed.** `M1 Playbook Engine` loads the selected playbook → merges with the client's audit results → generates a custom, prioritized AEO/SEO/GEO/local task roadmap. The `aeo-audit`, `schema-generation`, and `compliance-ruleset` skills all read the loaded playbook.

---

## Playbook schema (the structure every vertical fills in)

```yaml
playbook:
  vertical: string
  local_intensity: enum [hyper-local, semi-local, national]
  prompt_library: [ {prompt, intent, priority} ]        # what the tracker tests
  schema_profile: [schema types that matter, in priority order]
  channel_weighting: { channel: weight 0-100 }          # where authority is built
  compliance_ruleset_ref: skill://compliance-ruleset/<vertical>
  content_templates: [pillar/FAQ/local-page structures]
  entity_signals: [what makes the entity resolvable to AI]
  local_module_config: { enabled, gbp_priority, nap_directories, multi_location }
  citation_sources: [third-party sources AI pulls from in this niche]
  kpi_focus: [the metrics that matter most for this vertical]
```

---

## 2.1 — CANNABIS

```yaml
vertical: cannabis
local_intensity: hyper-local
```

**Context.** Cannabis is compliance-boxed out of most paid channels and much of traditional indexing (menu platforms like Dutchie have indexability gaps). Authority is won locally and through non-ad channels. This is the highest-compliance vertical — the compliance gate is strict.

**Prompt library (tracker tests these across all engines):**
- "best dispensary near me" / "best dispensary in [city]" — *transactional, high priority*
- "where to buy [product type] in [city]" — *transactional*
- "strongest [category] strains" / "best [strain] for [effect]" — *research*
- "is [dispensary] legit / reviews" — *reputation*
- "[city] dispensary deals / first-time discount" — *transactional*
- "what is [cannabinoid/terpene] good for" — *educational, safe-to-own*
- "cannabis delivery [city]" — *transactional*

**Schema profile (priority order):** LocalBusiness (Store), Product+Offer (menu items), FAQPage, Organization, Review/AggregateRating, Article (education).

**Channel weighting:**
| Channel | Weight | Why |
|---|---|---|
| Google Business Profile + local | 30 | Hyper-local intent dominates |
| Reddit (r/cannabis, city subs, strain subs) | 20 | Heavily cited by AI; ad-channel alternative |
| Reviews (Google/Weedmaps/Leafly) | 20 | Trust + local ranking |
| On-site education (strains, effects, terpenes) | 15 | AEO citation surface |
| Menu-platform + off-menu indexable pages | 10 | Exploit Dutchie indexability gap with own pages |
| Meta ads | 0 | **Prohibited — compliance gate blocks** |

**Compliance ruleset (hard gates):** no platform ads where prohibited; age-gating; no health/disease claims; no interstate commerce implications; state-specific rules; no content targeting minors; claim substantiation.

**Content templates:** strain/product education pages (effect + terpene + use case, direct-answer format), "dispensary in [city]" local pages, first-time-customer FAQs, cannabinoid explainer pillars.

**Entity signals:** consistent NAP across Weedmaps/Leafly/Google, licensed-operator profiles, brand mentions in city cannabis media, review velocity.

**Citation sources AI pulls from:** Reddit, Leafly, Weedmaps, local news, cannabis-education sites.

**Local config:** enabled; GBP priority HIGH; NAP directories = Google, Weedmaps, Leafly, Apple Maps, Yelp; multi-location supported (dispensary chains).

**KPI focus:** local-pack ranking, citation in "near me" AI answers, review velocity, menu-page indexation.

---

## 2.2 — REAL ESTATE (luxury / investor-focused, per GG)

```yaml
vertical: real-estate
local_intensity: semi-local
```

**Context.** Authority is built through entity recognition, long-form evergreen resources, existing PR, and podcast/thought-leadership. This is the "resource center + FAQ/video hub + entity leverage" model already validated on GG.

**Prompt library:**
- "best [city] real estate advisor for [buyer type]" — *high priority, entity*
- "how do [nationality] buy property in [city]" — *research, transactional*
- "can [nationality] get a mortgage in [city]" — *research*
- "[city] golden visa / residency real estate requirements" — *research, regulatory*
- "is [city] real estate a good investment / a bubble" — *research*
- "do [nationality] pay taxes on [city] property" — *research*
- "who is [advisor name]" — *entity recognition*
- "[podcast name]" — *entity recognition*

**Schema profile:** Person (+ sameAs — highest value), RealEstateAgent/Organization, FAQPage, Article, VideoObject (FAQ videos), Podcast, Breadcrumb.

**Channel weighting:**
| Channel | Weight | Why |
|---|---|---|
| On-site resource center (pillars + FAQ + video) | 30 | Core AEO citation surface |
| Entity leverage of existing PR (Person sameAs) | 25 | Highest-value, existing asset |
| Evergreen refresh (60–90 day) | 15 | Freshness + authority |
| Reddit/Quora (investor/expat threads) | 12 | AI citation sources |
| LinkedIn long-form (advisor's voice) | 10 | Entity authority |
| Podcast citations on FAQ pages | 8 | Entity connections |

**Compliance ruleset:** Fair Housing language; no misleading investment guarantees; accurate regulatory statements (visa/tax) with dateModified discipline.

**Content templates:** pillar pages per topic (buying process, mortgages, visa, taxes, investment), each FAQ as its own indexable text page with direct-answer opening + full transcript + VideoObject schema, "as featured in" press section.

**Entity signals:** Person sameAs aggregating press/bylines/LinkedIn/YouTube/podcast/credentials (RERA/NAR/CIPS); consistent naming across the web; author box on every page.

**Citation sources:** the advisor's own resource pages, Reddit, Quora, financial/property publications, the podcast.

**Local config:** enabled but semi-local; GBP priority MEDIUM; multi-location optional (markets served).

**KPI focus:** entity recognition ("who is X" answered correctly), citation in buyer-journey prompts, video-FAQ indexation, press-to-entity linkage.

---

## 2.3 — RESTAURANTS / FOOD / CAFES

```yaml
vertical: restaurants
local_intensity: hyper-local
```

**Context.** The most local vertical. Google Business Profile, reviews, menus, and local schema dominate. Multi-location support matters (groups/franchises).

**Prompt library:**
- "best [cuisine] restaurant near me / in [city]" — *transactional, high priority*
- "best brunch / coffee / [dish] in [neighborhood]" — *transactional*
- "[restaurant name] menu / hours / reservations" — *navigational*
- "restaurants open now near me" — *transactional*
- "best [dietary: vegan/gluten-free] restaurant [city]" — *research*
- "[restaurant name] reviews / is it good" — *reputation*
- "romantic / group / kid-friendly restaurant [city]" — *research*

**Schema profile:** Restaurant (+ Menu + MenuItem), LocalBusiness, FAQPage, Review/AggregateRating, Event (if applicable), Organization.

**Channel weighting:**
| Channel | Weight | Why |
|---|---|---|
| Google Business Profile + local | 35 | Dominant for food discovery |
| Reviews (Google/Yelp/TripAdvisor) | 25 | Trust + local ranking |
| Menu schema + indexable menu pages | 15 | AI menu answers |
| Local content (neighborhood/dish pages) | 10 | Long-tail local AEO |
| Social (Instagram — visual) | 10 | Discovery + brand |
| Reservation-platform presence | 5 | Navigational |

**Compliance ruleset:** health claims on food limited; allergen accuracy; alcohol rules where applicable; accurate hours/pricing.

**Content templates:** menu pages with MenuItem schema, "best [dish] in [city]" local pages, dietary-option FAQs, neighborhood guides, hours/reservation FAQ.

**Entity signals:** consistent NAP across Google/Yelp/TripAdvisor/Apple Maps, menu consistency, review velocity, local media mentions.

**Citation sources:** Google, Yelp, TripAdvisor, Reddit (city/food subs), local food blogs.

**Local config:** enabled; GBP priority CRITICAL; NAP directories = Google, Yelp, TripAdvisor, Apple Maps, OpenTable/Resy; multi-location = YES (per-location GBP + pages).

**KPI focus:** local-pack ranking, "near me" AI answer inclusion, review velocity, menu indexation, per-location visibility.

---

## 2.4 — HEALTH & LIFE INSURANCE

```yaml
vertical: health-life-insurance
local_intensity: semi-local
```

**Context.** Regulated, trust-heavy, compliance-sensitive (TCPA, Special Ad Category). Authority through E-E-A-T, licensed-agent entity signals, and educational content. This vertical also dogfoods the operator's own insurance SaaS platform.

**Prompt library:**
- "best [type] insurance for [demographic]" (e.g. final expense for seniors) — *transactional*
- "how much does [type] insurance cost" — *research*
- "[type] insurance with no medical exam" — *research*
- "is [type] insurance worth it" — *research*
- "best life insurance for [situation]" — *research*
- "[agency name] reviews / legit" — *reputation*
- "how to get [type] insurance in [state]" — *transactional*
- "difference between [product A] and [product B]" — *educational*

**Schema profile:** Organization/InsuranceAgency, Person (agents, + sameAs credentials), FAQPage, Article, Review/AggregateRating, Service.

**Channel weighting:**
| Channel | Weight | Why |
|---|---|---|
| On-site educational content (E-E-A-T) | 30 | AEO citation + trust |
| Licensed-agent entity signals | 20 | Credibility for AI + users |
| Reviews (Google/Trustpilot/BBB) | 20 | Trust in regulated space |
| Local + GBP (agency) | 15 | Semi-local intent |
| Comparison/education pillars | 10 | Research-stage capture |
| Reddit/Quora (personal-finance threads) | 5 | AI citation sources |

**Compliance ruleset (strict):** TCPA consent language on lead forms; no misleading guarantees ("guaranteed approval" limits); state licensing accuracy; Special Ad Category rules for any future ads; no fear-based manipulation; accurate product representation.

**Content templates:** product explainer pillars, cost/eligibility FAQs, comparison pages, "insurance in [state]" pages, agent bio pages with credentials.

**Entity signals:** licensed-agent Person schema with sameAs to NPN/state-license lookups, agency credentials, review profile, consistent NAP.

**Citation sources:** insurance-education sites, Reddit personal-finance, Trustpilot/BBB, gov/regulatory pages.

**Local config:** enabled semi-local; GBP priority MEDIUM; multi-location = agency offices/states.

**KPI focus:** citation in cost/comparison prompts, entity/credential recognition, lead-form conversions (attribution), review velocity.

---

## 2.5 — E-COMMERCE

```yaml
vertical: ecommerce
local_intensity: national
```

**Context.** National (or global), product-driven. Local module largely OFF. Authority through product schema, category content, reviews, and comparison/"best of" citation capture. This is where the local-intensity range is fully stress-tested at the "off" end.

**Prompt library:**
- "best [product category] for [use case]" — *transactional, high priority*
- "[brand] vs [competitor]" — *comparison*
- "is [brand/product] worth it / reviews" — *reputation*
- "best [product] under [price]" — *transactional*
- "where to buy [product]" — *navigational*
- "[product] alternatives" — *comparison*
- "how to choose [product category]" — *research*

**Schema profile:** Product (+ Offer + AggregateRating + Review), Organization/Brand, FAQPage, Article (buying guides), BreadcrumbList, ItemList (category/best-of).

**Channel weighting:**
| Channel | Weight | Why |
|---|---|---|
| Product + category schema/content | 30 | AI product answers |
| Buying guides + comparison content | 25 | "best [x]" citation capture |
| Reviews (on-site + third-party) | 20 | Trust + AI citation |
| Third-party "best of" listicle presence | 15 | AI pulls these heavily |
| Social/UGC (visual, Instagram/TikTok) | 10 | Discovery |
| Local | 0 | National — module off |

**Compliance ruleset:** FTC endorsement/review rules, pricing/claims accuracy, no deceptive comparisons, substantiation for superiority claims.

**Content templates:** product pages with full schema, "best [category]" buying guides (ItemList), comparison pages, use-case FAQs, category pillars.

**Entity signals:** Brand/Organization schema, consistent product data across channels, review aggregation, presence in third-party best-of lists.

**Citation sources:** Reddit, review sites, "best of" listicles, YouTube reviews, comparison sites.

**Local config:** DISABLED (national). Local module and GBP toggled off by the playbook.

**KPI focus:** citation in "best [category]" prompts, comparison-prompt inclusion, product-page indexation, review aggregation, third-party listicle presence.

---

## Cross-playbook notes for the Playbook Engine

- **local_intensity drives the local module.** hyper-local (cannabis, restaurants) → local module CRITICAL/HIGH; semi-local (real estate, insurance) → MEDIUM; national (e-commerce) → OFF. The engine toggles M14/M15 intensity accordingly.
- **The prompt_library seeds M3 (tracker) and M18 (resource center prompt-volume intelligence).** These are living lists — the resource center and PAA research expand them per client.
- **channel_weighting drives the generated task roadmap** — the plan allocates effort proportionally to where authority is actually built in that vertical, not evenly.
- **compliance_ruleset_ref is non-negotiable** — every content/ads output for the vertical passes the referenced ruleset via the Compliance Review agent.
- **Playbooks are versioned.** As operator experience accumulates across clients, playbooks improve — this compounding knowledge is the moat. The Documentation agent versions them.

---

## 2.6 — The Playbook Generator (M1b) — any industry, on demand

The five verticals above are the **seed set** — hand-authored from operator experience, and the ones proven first. But the platform must be able to onboard a client in **any** industry (med spas, legal, home services, SaaS, fitness, automotive, hospitality, B2B manufacturing — anything) without waiting for someone to hand-write a playbook. The Playbook Generator produces a new, complete playbook on demand.

**How it works:**
```
Operator enters a new industry (+ optional sub-niche, geography, business model)
        ↓
Generator (Anthropic API + web search, via the Resource Center M18 infrastructure):
  - researches how buyers in that industry query AI engines  → prompt_library
  - determines which schema types matter                     → schema_profile
  - infers where authority is actually built in that niche   → channel_weighting
  - sets local_intensity (hyper-local / semi-local / national)
  - drafts a compliance_ruleset (flags regulated industries for human review)
  - proposes content_templates + entity_signals + citation_sources
        ↓
DRAFT playbook  → mandatory human review (operator) + Compliance Review agent
        ↓
APPROVED → saved as a new versioned playbook, immediately usable for onboarding
```

**Rules:**
- A generated playbook is a **draft until a human approves it.** It is never used for live client work unstamped — the seed five are trusted; generated ones require sign-off. This keeps quality high and prevents a bad auto-playbook from driving real client output.
- **Regulated industries get flagged.** If the generator detects a regulated vertical (health, legal, financial, cannabis-adjacent, alcohol, etc.), it marks the compliance ruleset as "requires legal/compliance review before use" and the Compliance Review agent gates it harder.
- **Generated playbooks follow the exact same schema** as the hand-authored five (top of this doc), so everything downstream (tracker, audit, plan generator, compliance) consumes them identically — no special-casing.
- **Generated playbooks improve into seed-quality over time.** Once a generated playbook has run real clients successfully, it can be promoted to a trusted, curated playbook — the same compounding-knowledge moat, now self-expanding.

**When it's built:** the generator is **Phase 1** infrastructure-wise (it reuses the M18 Resource Center's Claude + web-search stack and the existing playbook schema), but it is **activated after the first vertical is proven end-to-end** (see doc 07). Early on you run on the curated five; once the loop is validated, the generator lets you say yes to any client in any industry the same day they onboard.

---

## Validation-first rollout (important — see doc 07 for the gate)

Although all five seed playbooks exist from day one, **Phase 1 proves the entire loop on ONE vertical and ONE client first — real estate, GG as client zero** — before the other verticals are switched into active client use, and before the Playbook Generator is turned on for live clients. This is a deliberate sequencing choice: validate onboard → plan → produce → publish → track → report on a single controlled client, fix the real-world rough edges, *then* fan out to the other seed verticals and enable on-demand playbook generation. The architecture is built for all industries from the start; the *rollout* is staged for safety and speed.
