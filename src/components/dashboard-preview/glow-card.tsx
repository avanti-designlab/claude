/**
 * The pass-3 "illuminated" card — working brand v1's glow language (operator
 * reference, 2026-07-08: backlit-glass cards — a thin neon cyan-blue edge, a
 * soft outer bloom, and a subtle radial glow rising inside the fill). Used
 * app-wide since the consolidation, SPARINGLY: the hero bubble plus one or
 * two earned moments per page; dense tables/forms stay quiet.
 *
 * Recipe (all layers are color-mix derivations over TOKENS — no literals):
 *  - EDGE  — a 1px transparent border painted by a `border-box` gradient
 *            (light-cyan → blue), so the rim reads as a lit edge, not a line.
 *  - FILL  — `padding-box` layers: an inner radial glow over a light→dark
 *            gradient (depth travels downward, per the reference).
 *  - BLOOM — layered box-shadows in token-derived blue (or red for the
 *            urgency panel): a tight halo plus a wide soft pool.
 *
 * MODE-AWARE: recipes are authored per polarity because token meaning flips
 * between the light and dark palettes (`--ink` is near-black on light,
 * near-white on dark). The card carries BOTH recipes as inline custom
 * properties and the app's standard mode mechanism picks one in CSS (the
 * `dark:` variant bound in globals.css to `prefers-color-scheme` + the
 * `data-theme` override) — no JS mode prop, no hydration dependence. Each
 * recipe is still a pure token derivation, so the card re-skins per tenant.
 *
 * The glow itself is STATIC. The optional `bloom` flag joins the entrance
 * choreography: the box-shadow ramps in 420ms after the card's rise begins
 * (`.entrance-bloom` in globals.css) — disabled to the instant final state
 * under both reduced-motion gates. Box-shadows never affect layout, so
 * mobile keeps zero overflow.
 */

import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/theme/utils";

export type GlowSurface = "hero" | "bubble" | "deep" | "alert";

interface GlowRecipe {
  /** `padding-box` background layers (inner radial + base fill), comma-joined. */
  fill: string;
  /** `border-box` gradient that paints the 1px illuminated edge. */
  edge: string;
  /** Layered box-shadow bloom/halo. */
  bloom: string;
}

interface ModeRecipes {
  light: GlowRecipe;
  dark: GlowRecipe;
}

const RECIPES: Record<GlowSurface, ModeRecipes> = {
  /* ------------------------------------------------------------------ */
  /* HERO — the floating rounded bubble. Light: vivid blue→navy fill     */
  /* with a soft blue halo (backlit glass in daylight). Dark: the        */
  /* reference — navy-to-black fill, neon cyan edge, blue bloom.         */
  /* ------------------------------------------------------------------ */
  hero: {
    light: {
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
    dark: {
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
  },

  /* ------------------------------------------------------------------ */
  /* BUBBLE — the showcase stat tile. Light: vivid blue with cyan glow.  */
  /* Dark: the reference chat bubble — light-cyan → vivid blue.          */
  /* ------------------------------------------------------------------ */
  bubble: {
    light: {
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
    dark: {
      fill:
        "linear-gradient(135deg, var(--accent-secondary), color-mix(in oklab, var(--accent-secondary) 35%, var(--accent)) 52%, var(--accent)) padding-box",
      edge:
        "linear-gradient(135deg, color-mix(in oklab, var(--accent-secondary) 40%, var(--ink)), color-mix(in oklab, var(--accent) 60%, var(--accent-secondary)))",
      bloom:
        "0 0 20px color-mix(in oklab, var(--accent) 35%, transparent), " +
        "0 0 60px color-mix(in oklab, var(--accent) 25%, transparent), " +
        "0 22px 60px -20px color-mix(in oklab, var(--accent) 50%, transparent)",
    },
  },

  /* ------------------------------------------------------------------ */
  /* DEEP — the momentum depth tile. Light: illuminated navy (ink) fill  */
  /* with blue glow rising. Dark: navy-to-black with the lit edge.       */
  /* ------------------------------------------------------------------ */
  deep: {
    light: {
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
    dark: {
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
  },

  /* ------------------------------------------------------------------ */
  /* ALERT — urgency wears the semantic NEGATIVE red (wash + red rim),   */
  /* never orange, never the brand accent (pass-3 rule).                 */
  /* ------------------------------------------------------------------ */
  alert: {
    light: {
      fill:
        "linear-gradient(120deg, color-mix(in oklab, var(--negative) 10%, var(--surface-raised)), var(--surface-raised) 55%) padding-box",
      edge:
        "linear-gradient(135deg, color-mix(in oklab, var(--negative) 38%, var(--surface-raised)), color-mix(in oklab, var(--negative) 12%, var(--surface-raised)))",
      bloom:
        "0 1px 2px color-mix(in oklab, var(--ink) 8%, transparent), " +
        "0 16px 44px -18px color-mix(in oklab, var(--negative) 30%, transparent)",
    },
    dark: {
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
  surface: GlowSurface;
  /** "hero" gets the most generous radius; "tile" matches the tile grid. */
  scale?: "hero" | "tile";
  /**
   * Join the entrance choreography: the glow's box-shadow blooms in after
   * the card lands (wrap the card in <Entrance> for the rise; the bloom
   * inherits the same --entrance-delay). Reduced motion renders the final
   * glow instantly. Use for the hero + at most one showcase tile per page.
   */
  bloom?: boolean;
  className?: string;
  children: ReactNode;
}

export function GlowCard({
  surface,
  scale = "tile",
  bloom = false,
  className,
  children,
}: GlowCardProps) {
  const { light, dark } = RECIPES[surface];
  return (
    <div
      className={cn(
        "relative overflow-hidden border border-transparent",
        // Both recipes ride inline custom properties; the standard mode
        // mechanism (dark: variant) picks one — no JS mode switch.
        "[background:var(--glow-bg-light)] [box-shadow:var(--glow-bloom-light)]",
        "dark:[background:var(--glow-bg-dark)] dark:[box-shadow:var(--glow-bloom-dark)]",
        bloom && "entrance-bloom",
        // Generous "bubble/popup" rounding, derived from the radius token.
        scale === "hero"
          ? "rounded-[calc(var(--radius)*4)]"
          : "rounded-[calc(var(--radius)*3)]",
        className
      )}
      style={
        {
          "--glow-bg-light": `${light.fill}, ${light.edge} border-box`,
          "--glow-bloom-light": light.bloom,
          "--glow-bg-dark": `${dark.fill}, ${dark.edge} border-box`,
          "--glow-bloom-dark": dark.bloom,
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}
