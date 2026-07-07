---
name: brand-kit-design-token
description: Encode a client's brand (logo, palette, typography, spacing, voice descriptors, product/founder likeness references) into enforceable design tokens + a voice profile. Serves BOTH the brand-consistent production engine AND white-label theming — one skill, two uses. Use when ingesting a client brand (M7 Brand Kit engine) or creating/updating a tenant theme.
---

# brand-kit-design-token

Encode a brand into an enforceable, locked kit: design tokens + voice profile. One skill, two uses — (1) the brand-consistent production engine forces all generated content/creative through the client's kit; (2) the white-label theming engine renders each tenant's dashboard in the tenant's brand (docs 05 M7, 06 §3, 03 `brand_kits`/`tenants.theme`).

## Inputs
- Brand assets: logo(s), color palette, typography, spacing preferences
- Voice samples: existing copy that exemplifies the brand voice
- Likeness references: product/founder imagery → Higgsfield/Motion reference element IDs

## Outputs
- **Token set** (colors/type/spacing) in the design-system token shape (doc 06 §2): `--surface`, `--surface-raised`, `--ink`, `--muted`, `--accent`, `--positive`, `--negative` + type scale. Stored in `brand_kits.tokens` (client kits) or `tenants.theme` (tenant/white-label themes).
- **Voice profile:** tone descriptors + representative samples + do/don't rules, stored in `brand_kits.voice_profile`. Content generation reads this at GENERATION time (brand voice from the start — not patched after).
- **Locked brand kit id** — `brand_kits.locked = true`, versioned. Once locked, everything produced downstream is forced through the kit so all assets look like the same brand.

## Rules
1. Tokens only — a hardcoded brand value anywhere in app UI or generated creative is a bug (Designer + Code Review reject).
2. Contrast is validated per theme (the theming engine checks accessibility on every tenant theme).
3. Kits are versioned; changing a locked kit creates a new version — history is never overwritten.
4. Likeness references live as Higgsfield/Motion reference element IDs on the kit (`brand_kits.likeness_refs`) so media generation stays on-brand and on-likeness.

## Used by
`lead-ui-ux-designer` (theming), the content pipeline (M8 voice), the social module (M11 creative).

## Status
**Implemented** at `src/lib/skills/brand-kit/` (87 isolation tests; `buildBrandKit` / `lockKit` / `reviseKit` / `toCssVariables` / `toTenantTheme`, WCAG contrast validation with auto-correction across all 10 F2 policy pairs — every foreground validated on both `surface` and `surfaceRaised`). Passed the 0.2 gate (Code Review + QA, remediated and re-verified 2026-07-07). This skill wraps that library — the 0.4 theming engine consumes it.
