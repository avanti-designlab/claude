# 06 — Design System & UI Spec
### Next-level, modern, brand-forward interface — built to a real aesthetic, not a template

> **Purpose.** Defines the design system, the white-label theming engine, the component/charting foundation, where high-impact animation is (and isn't) used, and the key screen specs. Owned by the `lead-ui-ux-designer` agent. This is **F2 in Phase 0** — built, design-reviewed, and frozen before feature UI is built on it.

> **Why this matters for this product specifically.** The operator's competitive edge is branding and design. The tool's own interface is therefore part of the pitch — when it's later licensed to agencies, the interface quality *is* the differentiator against the bootstrap-template look of most agency dashboards. Build it like a flagship product, not an internal admin panel.

---

## 1. Foundation stack

| Layer | Tool | Use |
|---|---|---|
| Components | **shadcn/ui + Tailwind CSS** | The full component system; fully themeable → white-label |
| Charts | **Recharts** | All analytics/visibility/ROI dashboards |
| High-impact animation | **Aceternity UI + Magic UI** | ONLY at the defined moments below |
| Icons | lucide-react | Consistent icon set |
| In-product media | Higgsfield + Motion (MCP) | Generates client *content* — never used to style the app |

---

## 2. Design direction (the aesthetic — a real choice, not a default)

> **Design lead instruction to the UI agent:** do NOT ship the generic AI-SaaS look (cream + serif + terracotta; or near-black + single acid accent; or hairline-broadsheet). This product is an *intelligence instrument* for a design-led agency. The direction is **"precision instrument meets studio."** Reference the frontend-design skill and pin the aesthetic deliberately before building.

**Direction: "Signal."** The product surfaces signal out of noise (AI citations, rankings, competitor gaps). The visual language should feel like a high-end analytics instrument: confident, data-forward, spacious, with one signature motion moment where "signal resolves out of noise." Because this is white-label, the *chrome* is neutral-premium and the *accent* is driven by the tenant's brand token — so the default theme is our agency's brand, and every reseller agency's theme is their own.

**Token system (default / our-agency theme — the Backend + Designer finalize):**
- The palette is expressed as design tokens, NOT hardcoded. Default theme values live in the token set; per-tenant themes override them via `tenants.theme` (doc 03).
- Define 4–6 named tokens: `--surface` (deep neutral base), `--surface-raised`, `--ink` (high-contrast foreground), `--muted` (secondary text), `--accent` (tenant-driven brand color), `--positive` / `--negative` (citation up/down, rank up/down). Pick default hex values that are premium and neutral so the accent (brand-driven) does the talking — avoid the three default AI-SaaS palettes named in the frontend-design skill.
- **Type:** a characterful display face used with restraint for big data moments (the Visibility Score, section heroes), a clean body face for dense dashboard reading, and a mono/utility face for data, metrics, and code/schema views. Set a real type scale. The type treatment on the big numbers (visibility score, share-of-voice) is a memorable part of the design.
- **Structure encodes meaning:** the module/pipeline stages (generate → humanize → review → publish) are a real sequence, so sequential numbering/steppers are appropriate *there*. Elsewhere, avoid decorative numbering.

**Signature element:** the **Visibility Score "resolve"** — the one memorable moment. On dashboard load and on each new tracker run, the client's AI-visibility score animates from noise into a resolved value, with the per-engine citation dots settling into place. This is the single high-impact motion; everything around it stays quiet and disciplined.

---

## 3. White-label theming engine (F2 — critical, built from day one)

- Every color, logo, font, and the accent are **design tokens** driven by `tenants.theme` and, for content, `brand_kits.tokens`.
- The `brand-kit-design-token` skill produces the token set; the theming engine consumes it.
- A tenant (agency) sets: logo, custom domain, accent color, optional font. The client-facing dashboard renders entirely in that tenant's brand. **We are tenant #1 — our own agency brand is the first theme, which exercises the white-label path immediately.**
- Client-viewers never see platform branding; only the agency's.
- Test: swapping the theme token set re-skins the entire app with zero code changes. If any color/logo is hardcoded, it's a bug the Designer + Code Review reject.

---

## 4. Where animation is used (and where it is NOT)

**Aceternity UI + Magic UI ONLY at these moments** (intentional, not scattered — scattered motion reads AI-generated):
1. **Onboarding flow** — the industry-select → connect → plan-generation reveal (the "your custom plan is assembling" moment).
2. **Dashboard hero** — the Visibility Score "resolve" signature animation.
3. **Tracker results** — per-engine citation dots settling; competitor gap surfacing.
4. **Empty states** — inviting first-action moments (not mood decoration).
5. **Key transitions** — plan → task → published, as a satisfying state change.

**No animated flourish** on: dense data tables, settings, forms, bulk-change previews, review queues. These stay fast, quiet, legible. Respect `prefers-reduced-motion` everywhere.

---

## 5. Key screens (Frontend Engineer builds against these)

### Onboarding
```
[ Select industry ]  cannabis · real-estate · restaurants · insurance · ecommerce
        ↓
[ Add location(s) ]  (drives local intensity)
        ↓
[ Connect properties ]  detect platform → API / edge-worker / PR guide
        ↓
[ Plan assembling… ]  ← animated moment; playbook + audit → roadmap
        ↓
[ Custom AEO/SEO/GEO/local plan ]  prioritized tasks, effort-weighted by channel
```

### Operator dashboard (per client)
- Visibility Score (signature animation) + trend line (Recharts)
- Share-of-voice vs named competitors
- Open tasks by module + automation_level (auto / ai-draft / human-only)
- Content pipeline status (draft → humanize → review → publish)
- Alerts feed (M17)
- Local rankings (if playbook local-intensity ≠ off)
- ROI panel (M16)

### Content pipeline view
- Kanban of content through the mandatory pipeline (doc 05 Part B): Generate → Humanize → Detection → Quality → Compliance → Schema → Publish. Each card shows its humanization/detection score and review verdicts. Nothing advances past a failed gate.

### Auto-fix / changes view
- Pending diffs (preview before apply), applied changes log, one-click rollback, auto-rollback events. This screen is deliberately utilitarian and unambiguous — no animation, maximum clarity, because it writes to live client sites.

### White-label client dashboard (M19)
- The agency-branded, read-only view: Visibility Score over time, share-of-voice, local rankings, **work-done log** (proof of work — the retention weapon), content calendar, ROI. Renders in the tenant's theme.

### Industry Resource Center (M18)
- A Claude-powered chat scoped to the client's vertical; research aid for operators/clients. Clean, conversational, with cited sources from web search.

---

## 6. Copy/voice (design material, not decoration)
- Name things by what the user controls: "Approve change," "Publish blog," "Revert" — not system internals.
- An action keeps its name through the flow: "Publish" → toast "Published."
- Errors explain what happened + how to fix, in the interface's voice, never vague.
- Empty states invite the next action.
- Sentence case, plain verbs, no filler. Tone: precise, confident, calm — an instrument, not a hype tool.

---

## 7. Quality floor (non-negotiable, built in quietly)
- Responsive to mobile.
- Visible keyboard focus; accessible contrast on all themes (including tenant themes — the theming engine validates contrast).
- `prefers-reduced-motion` respected (disables the signature animations).
- Fast: dense data views virtualized; no layout shift on the Visibility Score resolve.

---

## 8. Freeze criteria (Phase 0 exit for F2)
1. Token system + theming engine complete; full re-skin via token swap proven (no hardcoded brand values).
2. Component library on shadcn/ui + Tailwind established.
3. Recharts data-viz language defined.
4. The 5 animated moments implemented and gated behind reduced-motion.
5. Design review passed. Then feature UI may build on it.
