/**
 * Base-URL refusals that NEVER echo the refused value — shared by every write
 * method (carried item (α) from the 1.3 WordPress/Webflow gates).
 *
 * THE CLASS THIS KILLS: a configured base URL is exactly where a credential
 * lands by mistake — `?token=SECRET`, `#access_token=SECRET`, userinfo, or a
 * malformed paste that still embeds a secret. Any refusal message that repeats
 * the configured value (or any parsed piece of it) can therefore hand that
 * secret to every operator-facing error surface. Individual adapters kept
 * re-deciding this per branch, and one branch (the WordPress query/fragment
 * refusal) got it wrong — so the decision is hoisted HERE, once, and no
 * refusal branch composes its own message anymore.
 *
 * Contract for callers (enforced by regression tests sweeping every branch):
 *  - `why` and `remedy` are STATIC interface-voice strings. They must never
 *    interpolate the configured URL, any component of it (protocol, host,
 *    query, ...), or anything else derived from operator-supplied config.
 *    The only dynamic pieces of the composed message are our own coordinates:
 *    the method name and the property id.
 *  - The standard non-echo clause is appended by the helper itself, so every
 *    refusal explains WHY the value is withheld in the same words.
 */

import type { SiteChangeMethod } from "@/lib/types/db";
import { WriteMethodError } from "./errors";

/**
 * Build the one-and-only `misconfigured` refusal for an unusable base/API URL.
 * `why` states what is wrong ("has a base URL that carries a query or
 * fragment ..."); `remedy` tells the operator what to do ("reconnect the
 * property with the site's bare https:// address"). Both MUST be static —
 * see the module contract above.
 */
export function refuseBaseUrl(
  method: SiteChangeMethod,
  propertyId: string,
  why: string,
  remedy: string,
): WriteMethodError {
  return new WriteMethodError(
    method,
    "misconfigured",
    `${method}: property ${propertyId} ${why} (the configured value is not echoed here because base URLs can embed credentials); ${remedy}`,
  );
}
