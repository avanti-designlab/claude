---
name: compliance-ruleset
description: Per-vertical compliance rules that gate content and ads output for cannabis, real-estate, restaurants, health-life-insurance, and ecommerce. Input is vertical + content/asset (+ jurisdiction where relevant); output is pass/fail + specific violations + required fixes. Used by the compliance-review agent — the hard legal gate before anything publishes.
---

# compliance-ruleset

Per-vertical compliance rules that gate content and ads output. Nothing ships for a vertical without passing its ruleset (doc 00 §7.7). Consumed by the `compliance-review` agent via each playbook's `compliance_ruleset_ref` (doc 02).

## Inputs
- Vertical: `cannabis` | `real-estate` | `restaurants` | `health-life-insurance` | `ecommerce` (generated playbooks add new verticals — see rules below)
- Content or asset to evaluate
- Jurisdiction, where relevant (state rules differ for cannabis and insurance)

## Output
`pass` / `fail` + the specific violations found + the required fixes. A fail is a hard block.

## Rulesets

### cannabis (strictest vertical)
- No ads on prohibited platforms (Meta ads: weight 0 — prohibited; the gate blocks any Meta ad output).
- Age-gating required on content/experiences.
- No health/disease claims about cannabis products; claim substantiation required.
- No interstate-commerce implications (state-licensed operation only).
- State-specific rules apply per jurisdiction; no content targeting minors.

### real-estate
- Fair Housing language compliance (no steering, no discriminatory preference language).
- No misleading investment guarantees.
- Accurate regulatory statements (visa/golden-visa/tax) with `dateModified` discipline — regulatory content must carry a real last-verified date.

### restaurants
- Health claims on food limited; allergen accuracy required.
- Alcohol rules where applicable.
- Accurate hours/pricing (stale operational facts are compliance failures, not just quality issues).

### health-life-insurance (strict)
- TCPA consent language on all lead forms.
- No misleading guarantees ("guaranteed approval" limits).
- State licensing accuracy (agent/agency licensed in the states referenced).
- Special Ad Category rules for any future ads output.
- No fear-based manipulation; accurate product representation.

### ecommerce
- Pricing/claims accuracy; substantiation for superiority claims.
- FTC endorsement/review rules (disclosures on endorsements; no fake/incentivized-undisclosed reviews).
- No deceptive comparisons.

### health claims (cross-cutting: supplements/food)
- No disease claims; FTC substantiation for any health-adjacent claim.

## Rules for generated playbooks (M1b)
A generated playbook's drafted compliance ruleset is marked **"requires legal/compliance review before use"** when the industry is regulated (health, legal, financial, cannabis-adjacent, alcohol, …). It is a draft until a human approves it; the compliance-review agent gates it harder.

## Status
**Implemented** at `src/lib/skills/compliance/` (91 isolation tests; `checkCompliance` entry point, 32 rules across the five seed verticals, every rule carrying a legal reference). Fails closed on unknown verticals AND on zero-rules-evaluated; seed rulesets are immutable at runtime — replacing one is a reviewed code change, never an API call. Passed the 0.2 gate (Code Review + QA, remediated and re-verified 2026-07-07). This skill wraps that library; it pre-screens — it never replaces the compliance-review agent or human sign-off.
