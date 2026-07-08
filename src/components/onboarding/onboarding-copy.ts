/**
 * Presentation constants for the Phase 1.1 onboarding flow.
 *
 * These are UI copy and labels only — the sentence-case, plain-verb voice of
 * doc 06 §6, plus the platform connection guidance paraphrased from doc 04 §4.
 * NO product data lives here: the playbook, its local intensity, and the plan
 * all come from the real engine (`@/lib/playbooks`, `@/lib/plan`). This file
 * only maps engine values to human-readable strings.
 */

import type { LucideIcon } from "lucide-react";
import {
  BuildingIcon,
  LeafIcon,
  ShieldCheckIcon,
  ShoppingBagIcon,
  UtensilsIcon,
} from "lucide-react";
import type {
  LocalIntensity,
  SeedVertical,
} from "@/lib/types/playbook";
import type {
  AutomationLevel,
  PropertyConnectionMethod,
  PropertyPlatform,
} from "@/lib/types/db";
import type { ImpactLevel, ModuleRef } from "@/lib/types/roadmap";

/* ------------------------------------------------------------------ */
/* Step 1 — industry                                                   */
/* ------------------------------------------------------------------ */

export interface VerticalMeta {
  id: SeedVertical;
  label: string;
  /** One line on what the playbook optimizes for this vertical. */
  blurb: string;
  icon: LucideIcon;
}

/** The five seed verticals, in the doc 06 §5 order. Order and copy only. */
export const VERTICAL_META: VerticalMeta[] = [
  {
    id: "real-estate",
    label: "Real estate",
    blurb: "Agents, brokerages, neighborhood authority, and local answers.",
    icon: BuildingIcon,
  },
  {
    id: "cannabis",
    label: "Cannabis",
    blurb: "Dispensaries and brands in a tightly regulated, hyper-local market.",
    icon: LeafIcon,
  },
  {
    id: "restaurants",
    label: "Restaurants",
    blurb: "Menus, reviews, reservations, and near-me discovery.",
    icon: UtensilsIcon,
  },
  {
    id: "health-life-insurance",
    label: "Health & life insurance",
    blurb: "Advisors and agencies where trust and compliance lead.",
    icon: ShieldCheckIcon,
  },
  {
    id: "ecommerce",
    label: "Ecommerce",
    blurb: "Product catalogs and brands competing for AI product answers.",
    icon: ShoppingBagIcon,
  },
];

/* ------------------------------------------------------------------ */
/* Step 2 — locations (hint reflects playbook.local_intensity)         */
/* ------------------------------------------------------------------ */

/**
 * The hint reflects the loaded playbook's `local_intensity`. `null` covers the
 * pre-data state (the playbook engine lands in parallel) — honest, not broken.
 */
export function localIntensityHint(
  intensity: LocalIntensity | null
): string {
  switch (intensity) {
    case "hyper-local":
      return "Hyper-local: rankings are won block by block. Add every location you serve — each one gets its own local push.";
    case "semi-local":
      return "Semi-local: location shapes a meaningful share of your visibility. Add the areas you want to own.";
    case "national":
      return "National reach: location matters less here, but it still sharpens local answers where you have a presence.";
    default:
      return "Add the places you serve. Local intensity tunes automatically once your industry playbook loads.";
  }
}

export function localIntensityLabel(
  intensity: LocalIntensity | null
): string {
  switch (intensity) {
    case "hyper-local":
      return "Hyper-local";
    case "semi-local":
      return "Semi-local";
    case "national":
      return "National";
    default:
      return "Detecting";
  }
}

/* ------------------------------------------------------------------ */
/* Step 3 — connect properties (doc 04 §4 guidance, UI preview only)   */
/* ------------------------------------------------------------------ */

export interface PlatformGuidance {
  id: PropertyPlatform;
  label: string;
  /** Which change-management method this platform resolves to (doc 04 §1). */
  method: PropertyConnectionMethod;
  methodLabel: string;
  /** What auto-fix coverage looks like on this platform. */
  capability: string;
  /** Plain-language description of what WOULD happen once connected. */
  guidance: string;
  /** Build-deferred methods carry an honest "later phase" note. */
  phaseNote?: string;
}

/** Platform → connection method, paraphrased from doc 04 §1 and §4. */
export const PLATFORM_GUIDANCE: Record<PropertyPlatform, PlatformGuidance> = {
  wordpress: {
    id: "wordpress",
    label: "WordPress",
    method: "api",
    methodLabel: "Direct API",
    capability: "Full auto-fix",
    guidance:
      "We connect through the REST API and our plugin, then write H1s, titles, meta, schema, alt text, and content directly — every change previewed first.",
  },
  webflow: {
    id: "webflow",
    label: "Webflow",
    method: "api",
    methodLabel: "Direct API",
    capability: "Auto-fix",
    guidance:
      "We connect through the CMS and Designer APIs to write SEO fields, CMS content, and alt text; schema goes in via a custom-code embed.",
  },
  wix: {
    id: "wix",
    label: "Wix",
    method: "api",
    methodLabel: "Direct API",
    capability: "Partial auto-fix",
    guidance:
      "We connect through the Wix Data and SEO APIs to write meta, titles, schema, and some content. Deeper structural fixes fall back to the edge worker.",
  },
  framer: {
    id: "framer",
    label: "Framer",
    method: "edge_worker",
    methodLabel: "Edge worker",
    capability: "Edge auto-fix",
    guidance:
      "Framer's API can't write SEO fields, so a Cloudflare edge worker rewrites tags and schema at delivery — before crawlers and AI engines see the page.",
  },
  nextjs: {
    id: "nextjs",
    label: "Next.js / coded",
    method: "pr",
    methodLabel: "Pull request",
    capability: "Reviewed change",
    guidance:
      "We open a pull request with the exact change for your team to review and merge — so auto-fixes never fight your deploy pipeline.",
    phaseNote: "Connects in a later phase.",
  },
  custom: {
    id: "custom",
    label: "Custom / other",
    method: "edge_worker",
    methodLabel: "Edge worker",
    capability: "Edge auto-fix",
    guidance:
      "A Cloudflare edge worker covers custom stacks — it rewrites tags and schema at the edge, so any site config is reachable.",
  },
};

/** Platform select order: true auto-fix first, then edge, then PR. */
export const PLATFORM_ORDER: PropertyPlatform[] = [
  "wordpress",
  "webflow",
  "wix",
  "framer",
  "nextjs",
  "custom",
];

/* ------------------------------------------------------------------ */
/* Step 5 — plan (roadmap value → label maps)                          */
/* ------------------------------------------------------------------ */

/** Owning-module labels (doc 00 module map / roadmap.ts ModuleRef). */
export const MODULE_LABEL: Record<ModuleRef, string> = {
  M2: "Audit",
  M3: "Visibility",
  M4: "Competitors",
  M5: "Crawl access",
  M6: "Freshness",
  M8: "Content",
  M10: "Schema",
  M11: "Social",
  M12: "PR & entity",
  M14: "Local SEO",
  M15: "Reviews",
};

export interface AutomationMeta {
  label: string;
  /** Plain-language explanation of who acts (doc 03 §6). */
  hint: string;
}

/** automation_level → human label + who-acts hint (doc 03 §6). */
export const AUTOMATION_META: Record<AutomationLevel, AutomationMeta> = {
  auto: {
    label: "Automated",
    hint: "Runs on its own — tracking, validation, and reporting.",
  },
  ai_draft_human_approve: {
    label: "AI draft · you approve",
    hint: "AI drafts it; nothing publishes until you approve.",
  },
  human_only: {
    label: "Human only",
    hint: "Real participation or sign-off — done by a person.",
  },
};

/** Badge variant per impact level (design-system badge variants only). */
export const IMPACT_BADGE_VARIANT: Record<
  ImpactLevel,
  "default" | "secondary" | "destructive" | "outline"
> = {
  critical: "destructive",
  high: "default",
  medium: "secondary",
  low: "outline",
};

export const IMPACT_LABEL: Record<ImpactLevel, string> = {
  critical: "Critical",
  high: "High impact",
  medium: "Medium",
  low: "Low",
};
