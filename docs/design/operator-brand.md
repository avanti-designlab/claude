# Operator brand (tenant #1) — the agency's own brand theme

Source: operator's brand guide (provided 2026-07-08). This is the brand the app
renders in by default (tenant #1), applied through the frozen theming engine —
NOT a change to the frozen token *system*, only its values.

> **Hex values below are approximations read from the brand-guide screenshot.**
> Replace with the exact brand-guide values when supplied.

## Brand colors

| Name | Approx hex | Role in the product |
|---|---|---|
| **Core Blue** | `#1B2FCE` (vivid royal/cobalt) | PRIMARY accent — buttons, links, focus ring, primary CTAs, the signature "Signal resolves" moment |
| **Core Orange** | `#FC4C14` (vivid orange-red) | SECONDARY / energy accent — gradient moments, secondary highlights, illustrative pops (used sparingly) |
| **Dark Blue** | `#0A1C46` (deep navy) | Deep surfaces + branded ink (dark sections, headings-on-light option) |
| **Alachua** | `#F4A200` (amber gold) | Warm highlight accent — tertiary pops, badges, accent details |

## Gradient rules (from the brand guide — honored in "moments" only)
- **Blue gradients run at 90°.**
- **Orange gradients run at 45°.**

## Token mapping (into our 7 named tokens + brand extras)
- `--accent` = Core Blue (primary).
- Brand extras layered by the operator theme (additive, not a change to the frozen 7): `--accent-secondary` = Core Orange, `--accent-warm` = Alachua, plus Dark Blue for dark surfaces.
- `--positive` = green, `--negative` = red — **kept visually distinct from Core Orange** so "brand energy" never reads as "something's wrong." (Citation-up / rank-down semantics stay universal green/red.)
- `--surface` = light off-white / light-grey canvas; `--surface-raised` = white cards (the Spendex-style airy product surface).
- `--ink` = near-black or Dark-Blue-tinted for a branded, premium feel.

## Craft (from the operator's reference set: Webflow /solutions/aeo + Spendex credit-SaaS)
- Light-first, airy, generous whitespace; white cards floating on a light-grey canvas; soft pastel gradient washes for moments.
- **Thin, elegant big numbers** (Visibility Score, share-of-voice) vs. **bold section headings** — the weight contrast is a signature.
- Signature UI details: **black circular arrow buttons (↗)**, **pill-shaped chart bars**, speech-bubble chart labels, generous rounding, outlined line-icons.
- Type: geometric grotesque display (Sora, WF-Visual-Sans-adjacent) + clean body + mono.
- Data viz: purposeful color — green up / red down with ▲▼ deltas; Core Blue / Core Orange / Alachua to distinguish categories.

## Accessibility
All brand colors pass through the brand-kit accessibility gate. Core Blue on white is high-contrast (safe for text). Core Orange on white is borderline for small text — the gate will correct where needed and the adjustment is reported, never silent.

## Pass 3 — "illuminated" blue-depth exploration (2026-07-08, /dashboard-preview only)

Operator direction + reference image (backlit-glass cards, Apple-grade dark premium,
layered light↔dark blues). Status: **exploration for operator reaction — not the
final palette call.** Core Orange + Alachua remain in the theme system but are OFF
this page.

- **Face:** Geist (variable 100–900, OFL-1.1, self-hosted `public/fonts/geist-var.woff2`)
  replaces Sora/Inter as the operator theme's display AND body — hierarchy via
  weight + tight tracking. Signal defaults keep Space Grotesk/Inter (frozen).
- **Blue-depth system** (two gated variant themes in `operator-theme.ts`,
  applied via `TenantThemeScope`; scope ids `operator-p3-light` / `operator-p3-dark`):
  - highlight cyan `#8fd4ff` (reference bubble tone) → `--accent-secondary`.
    Passes VERBATIM on the dark chrome; gate-corrected to `#0091eb` (3.11:1) on light — reported.
  - primary vivid blue → `--accent`: `#2456f0` (light chrome) / `#3f7cff` (dark chrome);
    both pass 3:1 verbatim, derived on-accent text ≥ 5.2:1.
  - deep navy anchor: dark surfaces `#050815` / `#0b1430` (Dark Blue #0a1c46 lineage);
    on light, gradient ends mix `--accent` toward the navy ink. Gradients travel light→dark.
  - dark-chrome semantics brightened: positive `#22c55e`, negative `#f43f5e` (zero gate corrections).
- **Urgency = semantic red** (operator: "red is smart for action items") — the
  needs-fixing zone wears negative washes/accents, never orange.
- **Glow language** (`GlowCard`, tokens/color-mix only, STATIC): 1px transparent
  border painted by a border-box cyan→blue gradient (the lit edge) + layered
  box-shadow bloom in token blue (red for urgency) + inner radial glow over a
  light→dark fill. Hero is a floating rounded card (radius `calc(var(--radius)*4)`),
  not a full-width band.
