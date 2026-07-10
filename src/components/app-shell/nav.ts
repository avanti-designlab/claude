/**
 * Shared navigation constants for the authenticated app shell. Client-safe
 * (no server imports) so both the server layout and client components can use
 * it. Kept out of src/lib/auth so the frozen auth layer stays untouched.
 *
 * The operator navigation is the app's information architecture: Home + Clients,
 * then the global studios (production), operations (review/measure/alert), and
 * knowledge, with the two workspace-administration surfaces — Connections and
 * Settings — pinned to the footer. It is consumed by the sidebar (desktop) and
 * the mobile Sheet — one source of truth so the two never drift.
 * ROLE-AWARENESS is enforced upstream: this model is the OPERATOR surface; a
 * `client_viewer` never renders it (see access.ts + the (app) layout).
 */

import type { LucideIcon } from "lucide-react";
import {
  BellRingIcon,
  BookOpenIcon,
  ClipboardCheckIcon,
  ImageIcon,
  LayoutDashboardIcon,
  LineChartIcon,
  PaletteIcon,
  PenLineIcon,
  PlugIcon,
  SettingsIcon,
  UsersRoundIcon,
} from "lucide-react";

/** Where a successful sign-in (and the top-bar wordmark) lands. */
export const APP_HOME = "/dashboard";

/** The public login route (mirrors guards' DEFAULT_LOGIN_PATH). */
export const LOGIN_PATH = "/login";

export interface AppNavItem {
  href: string;
  label: string;
  /** Sidebar/menu icon (lucide). Optional so plain link lists still type. */
  icon?: LucideIcon;
}

export interface AppNavGroup {
  /** Section label above the group; null renders the group with no heading. */
  label: string | null;
  items: AppNavItem[];
}

/**
 * The full operator navigation, grouped. Every destination here is an operator
 * (agency_admin / operator / platform_owner) surface — the studios and
 * operations that write, review, and measure across the whole book of clients.
 */
export const OPERATOR_NAV: AppNavGroup[] = [
  {
    label: null,
    items: [
      { href: "/dashboard", label: "Home", icon: LayoutDashboardIcon },
      { href: "/clients", label: "Clients", icon: UsersRoundIcon },
    ],
  },
  {
    label: "Studios",
    items: [
      { href: "/content-studio", label: "Content Studio", icon: PenLineIcon },
      { href: "/media-studio", label: "Image & Media", icon: ImageIcon },
      { href: "/brand-kits", label: "Brand Kits", icon: PaletteIcon },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        href: "/review-queue",
        label: "Review & Approvals",
        icon: ClipboardCheckIcon,
      },
      { href: "/measurement", label: "Measurement", icon: LineChartIcon },
      { href: "/alerts", label: "Alerts", icon: BellRingIcon },
    ],
  },
  {
    label: "Knowledge",
    items: [
      { href: "/resource-center", label: "Resource Center", icon: BookOpenIcon },
    ],
  },
];

/**
 * Pinned to the bottom of the sidebar, apart from the primary groups — the
 * workspace-administration surfaces (which vendors are wired; the workspace
 * itself), a different register from the per-client operational feeds above.
 */
export const OPERATOR_NAV_FOOTER: AppNavItem[] = [
  { href: "/connections", label: "Connections", icon: PlugIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
];

/**
 * Flat list of every operator destination — the primary top-of-nav items, kept
 * for any consumer that wants a simple link list (and backward compatibility).
 */
export const APP_NAV: AppNavItem[] = OPERATOR_NAV[0].items;

/**
 * Active-state test for a nav href against the current pathname. Exact match, or
 * a descendant path (`/clients` lights up while inside a client workspace).
 * Kept here so the sidebar and mobile Sheet compute "active" identically.
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + "/");
}
