# 04 — Auto-Fix & Integrations Engine
### Writing real changes to client sites — safely — across four platforms

> **Purpose.** Defines how the platform connects to client site backends and writes actual on-page/technical fixes (H1s, title tags, meta descriptions, alt text, schema, canonicals, content), plus all external connectors. Owned by the `integrations-engineer` agent. The defining requirement: **four connection methods, one unified safety layer.**

> **The non-negotiable.** No write to a client site may bypass the change-management layer (change-log + diff-preview + one-click-rollback + auto-rollback). The Code Review and QA agents enforce this as a hard gate.

---

## 1. Connection methods (matched to the operator's real client mix)

The operator's clients run on **WordPress, Webflow, Framer, and Wix**, with **Next.js / coded sites coming in a later company phase**. That mix dictates exactly these methods and this priority.

### Method 1 — CMS / API writes (primary; true auto-fix)
Direct programmatic writes to the live site via the platform's API.

| Platform | Capability | Notes |
|---|---|---|
| **WordPress** | Full auto-fix | REST API + a purpose-built plugin. Writes H1, title, meta, schema, alt, content. **Gold standard, highest coverage — build first.** |
| **Webflow** | Auto-fix (workable) | CMS + Designer/Data APIs. SEO fields (title, meta, OG), CMS content, alt; schema via custom-code embeds. Some page-level settings more constrained than CMS-collection fields. **Build second.** |
| **Wix** | Partial auto-fix | Wix Data + SEO APIs. Meta/title/schema + some content writable; most walled-garden of the four; deeper structural fixes less reliable. **Build third.** |

### Method 2 — Cloudflare edge worker (universal fallback; REQUIRED for Framer)
A lightweight worker (or script injection) rewrites tags/schema at delivery time, before the page reaches users and crawlers. **This is not optional for this operator** — Framer has very limited programmatic API access for SEO writes, so the edge worker is the *only* reliable way to auto-fix Framer sites. It also covers any future weird site config. **Build in Phase 1, immediately alongside the CMS APIs.**

Per-client setup: a snippet or a Cloudflare Worker route on the client's domain. The worker fetches the platform's desired-state for that URL and applies the diffs at the edge.

### Method 3 — Git / Pull-Request (for coded / dev-managed sites)
The platform opens a PR with the exact code change for a developer to review and merge. Correct for sites where auto-writing live would fight a deploy pipeline. **Architected in the data model now (`site_changes.method = 'pr'`), built out in Phase 2 as the operator's Claude Code-built Next.js sites come online.** Also covers any current dev-managed client.

### Method priority for THIS operator
```
Phase 1:  WordPress API  →  Webflow API  →  Wix API  →  Cloudflare edge worker (for Framer + universal)
Phase 2:  Git/PR  (for Next.js / coded / dev-managed)
```
Rationale: WordPress + Webflow + Wix APIs cover three of four current platforms with true auto-fix; the edge worker covers Framer (otherwise uncovered) and everything else. All four are in the data model and architecture from day one; only Git/PR is build-deferred, and only because the coded sites don't exist yet.

---

## 2. The unified change-management layer (wraps ALL methods identically)

Regardless of which method performs the write, the change flows through one safety pipeline:

```
1. GENERATE desired change (from audit fix / content / schema module)
        ↓
2. PREVIEW  → produce a diff (before/after). For ai_draft_human_approve tasks,
             a human approves the diff. Nothing writes without this step.
        ↓
3. APPLY    → the chosen method writes the change; log a site_changes row
             (method, change_type, diff, applied_by, approved_by, status='applied').
        ↓
4. MONITOR  → watch traffic/ranking/visibility signals for regressions.
        ↓
5. ROLLBACK → one-click manual revert at any time; AUTO-rollback fires if a change
             correlates with a traffic/ranking drop beyond threshold.
             (status → 'reverted' | 'auto_reverted', reverted_reason logged)
```

**Hard requirements:**
- Every write produces a `site_changes` audit row (doc 03). No silent changes.
- Every write is reversible by exactly one action. Rollback restores prior state via the same method that applied it.
- Auto-rollback thresholds are configurable per client; the Alerting engine (M17) surfaces the event.
- Bulk changes (e.g. mass H1 or canonical edits) require explicit human approval and are previewed as a batch diff — this is the highest-risk operation and must never fire unattended.
- The QA agent maintains a dedicated rollback test suite; a method cannot ship until its rollback path is proven.

---

## 3. External connectors (all owned by the Integrations agent)

| Connector | Purpose | Approach |
|---|---|---|
| **AI engine access** (ChatGPT, Perplexity, Gemini, Claude, Copilot, Google AI Overviews) | Visibility tracker prompt panels | **Decision (locked): buy/rent the citation data via available APIs/connectors now — do NOT build scrapers.** Use engine APIs where they give usable results; use a licensed citation-data provider's API (Profound-class) for the surfaces that are fragile to capture (esp. Google AI Overviews). Revisit building in-house only at scale / when licensing to agencies. See §7 for the swappable-source requirement. |
| **Ayrshare-class social API** | Social scheduling/posting | Rent the posting plumbing. Do NOT build native per-platform integrations (maintenance sinkhole). |
| **GA4 + Search Console** | Attribution + rankings | Official APIs. Feeds ROI layer (M16) + reporting. |
| **Call tracking** | Attribution (lead-gen verticals) | Integrate a call-tracking provider; feeds M16. |
| **Higgsfield + Motion (MCP)** | In-product media production | Generate client video/image/voice assets. In-product engine, not app UI. |
| **Humanizer API** | Authenticity pass | Post-generation humanization (doc 05). |
| **AI-detection API** | Authenticity gate | Score content pre-publish; gate on threshold. |
| **GBP API** | Local module | Post updates, manage profile, pull reviews (M14/M15). |
| **Review platforms** (Yelp/TripAdvisor/Trustpilot/BBB where APIs allow) | Review management | Monitor + response drafting (M15). |
| **Secrets vault** | Credential storage | Supabase Vault / external secrets manager. Raw creds never in tables. |

---

## 4. Connection onboarding flow (per property)

```
Client added → for each property:
  detect platform (wordpress/webflow/wix/framer/nextjs/custom)
    → WordPress/Webflow/Wix  → guide API/plugin connect  → connection_method='api'
    → Framer / unknown        → guide edge-worker setup    → connection_method='edge_worker'
    → Next.js / coded         → guide Git/PR connect (P2)  → connection_method='pr'
    → none available          → connection_method='none'   → tool generates changes for manual apply
  store auth_ref → secrets vault
  verify write access with a no-op test change (previewed, not applied)
```

---

## 5. Security notes (Code Review gates)

- Every connector call is tenant-scoped; a tenant can only touch its own clients' properties.
- Credentials resolved from the vault at call time; never logged, never returned to the client.
- Edge workers are per-client isolated; one client's worker cannot affect another's domain.
- All writes authorized against the acting user's role (only `operator`/`agency_admin` can approve/apply; `client_viewer` never writes).

---

## 6. Build checklist for the Integrations agent (Phase 1)

- [ ] Unified change-management layer (build FIRST — everything writes through it)
- [ ] WordPress plugin/API write + rollback
- [ ] Webflow API write + rollback
- [ ] Wix API write + rollback
- [ ] Cloudflare edge worker write + rollback (covers Framer)
- [ ] Property connection onboarding + platform detection
- [ ] AI-engine access for tracker (or licensed data API)
- [ ] Ayrshare-class social posting
- [ ] GA4 + GSC + call-tracking for attribution
- [ ] Higgsfield + Motion media production hooks
- [ ] Humanizer + AI-detection APIs
- [ ] GBP + review-platform connectors
- [ ] Secrets vault wiring
- [ ] (Phase 2) Git/PR method

---

## 7. Swappable data sources (build-vs-buy, made pluggable)

**Locked decision for now:** use available APIs / connectors for both the **citation-tracking data** and the **social-posting** plumbing. Do not build scrapers or native platform integrations in Phase 1. Rent the commodity infrastructure; spend build energy on the moat (playbooks, brand production, auto-fix, humanization). Revisit building in-house only at scale or when licensing to agencies makes the per-query economics or data-ownership worth it.

**Requirement so "buy now, maybe build later" stays cheap:** every rented data source is behind a **provider-agnostic connector interface**, so swapping vendors (or later swapping in our own engine) changes one adapter, not the module.

```
CitationDataProvider (interface)
  .runPrompt(engine, prompt, geo) -> { cited, position, sentiment, cited_source, raw }
  implementations: ProfoundAdapter | <OtherVendor>Adapter | (future) InHouseAdapter

SocialPostingProvider (interface)
  .schedule(account, asset, caption, when) -> { status, post_id }
  implementations: AyrshareAdapter | <OtherVendor>Adapter | (future) NativeAdapter
```

Rules:
- Modules (M3 tracker, M11 social) call the **interface**, never a vendor SDK directly.
- Vendor keys live in the secrets vault, per-tenant where the tenant supplies their own.
- Normalize every vendor's response into our own schema (`visibility_results`, doc 03) so stored data is vendor-independent — history stays intact across a vendor switch.
- A vendor swap must require zero changes to any module or the data model. The Code Review agent rejects any module that imports a vendor SDK outside its adapter.
