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
