/**
 * DESIGN PREVIEW primitive — the pass-3 "illuminated" card (operator
 * reference, 2026-07-08: backlit-glass cards on a near-black canvas — a thin
 * neon cyan-blue edge, a soft outer bloom, and a subtle radial glow rising
 * inside the fill).
 *
 * Recipe (all layers are color-mix derivations over TOKENS — no literals):
 *  - EDGE  — a 1px transparent border painted by a `border-box` gradient
 *            (light-cyan → blue), so the rim reads as a lit edge, not a line.
 *  - FILL  — `padding-box` layers: an inner radial glow over a light→dark
 *            gradient (depth travels downward, per the reference).
 *  - BLOOM — layered box-shadows in token-derived blue (or red for the
 *            urgency panel): a tight halo plus a wide soft pool.
 *
 * The glow is STATIC — no animation, nothing to gate — and box-shadows never
 * affect layout, so mobile keeps zero overflow. Recipes are authored PER
 * VARIANT because token polarity flips between the light and dark chrome
 * (e.g. `--ink` is near-black on light, near-white on dark); each recipe is
 * still a pure token derivation, so either variant re-skins per tenant.
 *
 * Used at exactly the sanctioned "moment" surfaces on this page: the hero
 * card, the blue stat bubble, the momentum depth tile, and (red, subtle) the
 * needs-fixing panel. Not a frozen component-library primitive.
 */

import type { ReactNode } from "react";
import { cn } from "@/lib/theme/utils";
import type { BlueDepthVariant } from "@/lib/theme/operator-theme";

export type GlowSurface = "hero" | "bubble" | "deep" | "alert";

interface GlowRecipe {
  /** `padding-box` background layers (inner radial + base fill), comma-joined. */
  fill: string;
  /** `border-box` gradient that paints the 1px illuminated edge. */
  edge: string;
  /** Layered box-shadow bloom/halo. */
  bloom: string;
}

const RECIPES: Record<BlueDepthVariant, Record<GlowSurface, GlowRecipe>> = {
  /* ------------------------------------------------------------------ */
  /* LIGHT — floating cards on the airy canvas; the glow is a soft blue  */
  /* halo + a pale cyan rim (backlit glass in daylight).                 */
  /* ------------------------------------------------------------------ */
  light: {
    hero: {
      fill:
        // sheen top-right, cyan rim-light top-center, blue→navy base (depth downward)
        "radial-gradient(130% 150% at 84% -20%, color-mix(in oklab, var(--surface-raised) 18%, transparent), transparent 55%) padding-box, " +
        "radial-gradient(56% 34% at 50% 0%, color-mix(in oklab, var(--accent-secondary) 38%, transparent), transparent 72%) padding-box, " +
        "linear-gradient(115deg, var(--accent), color-mix(in oklab, var(--accent) 52%, var(--ink))) padding-box",
      edge:
        "linear-gradient(135deg, color-mix(in oklab, var(--accent-secondary) 55%, var(--surface-raised)), color-mix(in oklab, var(--accent) 35%, var(--surface-raised)) 45%, color-mix(in oklab, var(--accent-secondary) 30%, var(--surface-raised)))",
      bloom:
        "0 1px 2px color-mix(in oklab, var(--ink) 10%, transparent), " +
        "0 12px 32px color-mix(in oklab, var(--accent) 22%, transparent), " +
        "0 32px 80px -24px color-mix(in oklab, var(--accent) 45%, transparent)",
    },
    bubble: {
      fill:
        "radial-gradient(120% 140% at 100% 0%, color-mix(in oklab, var(--accent-secondary) 35%, transparent), transparent 55%) padding-box, " +
        "linear-gradient(135deg, var(--accent), color-mix(in oklab, var(--accent) 55%, var(--ink))) padding-box",
      edge:
        "linear-gradient(135deg, color-mix(in oklab, var(--accent-secondary) 50%, var(--surface-raised)), color-mix(in oklab, var(--accent) 30%, var(--surface-raised)))",
      bloom:
        "0 1px 2px color-mix(in oklab, var(--ink) 8%, transparent), " +
        "0 10px 28px color-mix(in oklab, var(--accent) 20%, transparent), " +
        "0 22px 56px -18px color-mix(in oklab, var(--accent) 40%, transparent)",
    },
    deep: {
      fill:
        "radial-gradient(130% 140% at 100% 0%, color-mix(in oklab, var(--accent) 42%, transparent), transparent 60%) padding-box, " +
        "linear-gradient(140deg, var(--ink), color-mix(in oklab, var(--ink) 78%, var(--accent))) padding-box",
      edge:
        "linear-gradient(135deg, color-mix(in oklab, var(--accent-secondary) 45%, var(--surface-raised)), color-mix(in oklab, var(--accent) 40%, var(--ink)) 60%, color-mix(in oklab, var(--accent-secondary) 25%, var(--ink)))",
      bloom:
        "0 1px 2px color-mix(in oklab, var(--ink) 10%, transparent), " +
        "0 10px 28px color-mix(in oklab, var(--accent) 18%, transparent), " +
        "0 24px 60px -18px color-mix(in oklab, var(--ink) 45%, transparent)",
    },
    alert: {
      // Urgency: a soft NEGATIVE wash + red rim — never orange (pass-3 note).
      fill:
        "linear-gradient(120deg, color-mix(in oklab, var(--negative) 10%, var(--surface-raised)), var(--surface-raised) 55%) padding-box",
      edge:
        "linear-gradient(135deg, color-mix(in oklab, var(--negative) 38%, var(--surface-raised)), color-mix(in oklab, var(--negative) 12%, var(--surface-raised)))",
      bloom:
        "0 1px 2px color-mix(in oklab, var(--ink) 8%, transparent), " +
        "0 16px 44px -18px color-mix(in oklab, var(--negative) 30%, transparent)",
    },
  },

  /* ------------------------------------------------------------------ */
  /* DARK — the reference: near-black canvas, neon cyan edge, blue bloom, */
  /* a radial blue glow rising inside a navy-to-black fill.               */
  /* ------------------------------------------------------------------ */
  dark: {
    hero: {
      fill:
        "radial-gradient(110% 140% at 12% -12%, color-mix(in oklab, var(--accent) 42%, transparent), transparent 56%) padding-box, " +
        "linear-gradient(178deg, color-mix(in oklab, var(--accent) 16%, var(--surface-raised)), var(--surface) 84%) padding-box",
      edge:
        "linear-gradient(135deg, color-mix(in oklab, var(--accent-secondary) 90%, transparent), color-mix(in oklab, var(--accent) 55%, transparent) 34%, color-mix(in oklab, var(--accent) 28%, transparent) 62%, color-mix(in oklab, var(--accent-secondary) 60%, transparent))",
      bloom:
        "0 0 22px color-mix(in oklab, var(--accent) 30%, transparent), " +
        "0 0 90px color-mix(in oklab, var(--accent) 20%, transparent), " +
        "0 34px 90px -30px color-mix(in oklab, var(--accent) 45%, transparent)",
    },
    bubble: {
      // The reference chat bubble: light-cyan → vivid blue.
      fill:
        "linear-gradient(135deg, var(--accent-secondary), color-mix(in oklab, var(--accent-secondary) 35%, var(--accent)) 52%, var(--accent)) padding-box",
      edge:
        "linear-gradient(135deg, color-mix(in oklab, var(--accent-secondary) 40%, var(--ink)), color-mix(in oklab, var(--accent) 60%, var(--accent-secondary)))",
      bloom:
        "0 0 20px color-mix(in oklab, var(--accent) 35%, transparent), " +
        "0 0 60px color-mix(in oklab, var(--accent) 25%, transparent), " +
        "0 22px 60px -20px color-mix(in oklab, var(--accent) 50%, transparent)",
    },
    deep: {
      fill:
        "radial-gradient(120% 140% at 88% -10%, color-mix(in oklab, var(--accent) 38%, transparent), transparent 58%) padding-box, " +
        "linear-gradient(180deg, color-mix(in oklab, var(--accent) 13%, var(--surface-raised)), var(--surface)) padding-box",
      edge:
        "linear-gradient(135deg, color-mix(in oklab, var(--accent-secondary) 75%, transparent), color-mix(in oklab, var(--accent) 45%, transparent) 40%, color-mix(in oklab, var(--accent-secondary) 45%, transparent))",
      bloom:
        "0 0 18px color-mix(in oklab, var(--accent) 26%, transparent), " +
        "0 0 60px color-mix(in oklab, var(--accent) 16%, transparent), " +
        "0 24px 70px -26px color-mix(in oklab, var(--accent) 40%, transparent)",
    },
    alert: {
      fill:
        "radial-gradient(130% 120% at 100% 0%, color-mix(in oklab, var(--negative) 20%, transparent), transparent 55%) padding-box, " +
        "linear-gradient(180deg, color-mix(in oklab, var(--negative) 6%, var(--surface-raised)), var(--surface-raised)) padding-box",
      edge:
        "linear-gradient(135deg, color-mix(in oklab, var(--negative) 55%, transparent), color-mix(in oklab, var(--negative) 16%, transparent) 45%, color-mix(in oklab, var(--negative) 38%, transparent))",
      bloom:
        "0 0 20px color-mix(in oklab, var(--negative) 16%, transparent), " +
        "0 24px 60px -26px color-mix(in oklab, var(--negative) 35%, transparent)",
    },
  },
};

export interface GlowCardProps {
  variant: BlueDepthVariant;
  surface: GlowSurface;
  /** "hero" gets the most generous radius; "tile" matches the tile grid. */
  scale?: "hero" | "tile";
  className?: string;
  children: ReactNode;
}

export function GlowCard({
  variant,
  surface,
  scale = "tile",
  className,
  children,
}: GlowCardProps) {
  const recipe = RECIPES[variant][surface];
  return (
    <div
      className={cn(
        "relative overflow-hidden border border-transparent",
        // Generous "bubble/popup" rounding, derived from the radius token.
        scale === "hero"
          ? "rounded-[calc(var(--radius)*4)]"
          : "rounded-[calc(var(--radius)*3)]",
        className
      )}
      style={{
        background: `${recipe.fill}, ${recipe.edge} border-box`,
        boxShadow: recipe.bloom,
      }}
    >
      {children}
    </div>
  );
}
