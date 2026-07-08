/**
 * Shared navigation constants for the authenticated app shell. Client-safe
 * (no server imports) so both the server layout and client components can use
 * it. Kept out of src/lib/auth so the frozen auth layer stays untouched.
 */

/** Where a successful sign-in (and the top-bar wordmark) lands. */
export const APP_HOME = "/clients";

/** The public login route (mirrors guards' DEFAULT_LOGIN_PATH). */
export const LOGIN_PATH = "/login";

export interface AppNavItem {
  href: string;
  label: string;
}

/** Primary in-shell destinations shown in the top bar. */
export const APP_NAV: AppNavItem[] = [
  { href: "/clients", label: "Clients" },
  { href: "/onboarding", label: "Onboard a client" },
];
