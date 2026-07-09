/**
 * M3 Visibility Tracker — query-set derivation (doc 05 §M3; doc 02).
 *
 * The playbook's `prompt_library` entries are TEMPLATES ("best [city] real
 * estate advisor for [buyer type]"). This module deterministically expands
 * them into the tracked query set — the exact prompt texts whose AI-engine
 * answers the sampler measures — from exactly two client facts we actually
 * hold: the client's recorded NAME and its LOCATIONS (doc 03 §3
 * `clients.locations`).
 *
 * HONESTY RULES (the module's whole point — never invent a query):
 * - A `[token]` is substituted ONLY when we have a real value for it:
 *   entity tokens (see {@link ENTITY_TOKENS}) → the client's recorded name;
 *   `[city]` → one variant per location, using the location's NAME as the
 *   market label (operator convention: name locations by market, e.g.
 *   "San Diego, CA" — free-form addresses are never mined for cities, that
 *   would be guesswork).
 * - A template with ANY unresolvable token is EXCLUDED and reported
 *   structurally in {@link DerivedQuerySet.excluded} — a thin playbook yields
 *   a small set, never a padded one. Excluded templates are the input for the
 *   per-client prompt-expansion work doc 02 calls "living lists".
 * - "near me" prompts are meaningless without a market: they are instantiated
 *   once per location (text unchanged, geo context attached), and excluded
 *   when the client has no locations.
 *
 * Deterministic: same playbook + same client facts → identical set, in a
 * stable order (high-priority templates first, then playbook order, then
 * client location order). No wall-clock, no randomness, no network.
 */

import type { CitationGeo } from "@/lib/connectors";
import type { ClientLocation } from "@/lib/types/db";
import type {
  Playbook,
  PromptIntent,
  PromptLibraryEntry,
  Vertical,
} from "@/lib/types/playbook";

/* ------------------------------------------------------------------ */
/* Tunables (⚑ operator ratification — doc-silent choices)             */
/* ------------------------------------------------------------------ */

/**
 * ⚑ OPERATOR RATIFICATION REQUIRED (doc-silent, chosen at 1.4): cap on the
 * derived query set. Each query is sampled on every engine (×6), so 100
 * queries = up to 600 rented provider calls per run — a cost guard, not a
 * product truth. Truncation is HONEST: lowest-priority queries drop from the
 * end and the count is reported in {@link DerivedQuerySet.dropped}, never
 * silently.
 */
export const MAX_TRACKED_QUERIES = 100;

/**
 * Bracketed tokens that mean "the client entity itself" across the seed
 * playbooks (doc 02: [advisor name], [agency name], [restaurant name],
 * [dispensary], [brand], [brand/product]) plus generic aliases generated
 * playbooks (M1b — same schema, no special-casing) are likely to use. All are
 * substituted with the client's recorded name. Finer-grained entity naming
 * (the advisor PERSON vs the firm) arrives with the brand-kit entity model —
 * until then the client record's name is the only entity name we hold.
 */
export const ENTITY_TOKENS: ReadonlySet<string> = new Set([
  "advisor name",
  "agency name",
  "restaurant name",
  "dispensary",
  "brand",
  "brand/product",
  "business name",
  "company name",
  "client name",
]);

/** The one location-resolvable token. */
const LOCATION_TOKEN = "city";

/** "near me" prompts need a market context to mean anything. */
const NEAR_ME = /\bnear me\b/i;

const PLACEHOLDER = /\[([^\]]+)\]/g;

const PRIORITY_RANK: Record<PromptLibraryEntry["priority"], number> = {
  high: 0,
  normal: 1,
};

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/** The client facts derivation may use — nothing else exists to use. */
export interface TrackedClientFacts {
  /** The client's recorded name (`clients.name`). */
  name: string;
  /** The client's recorded locations (`clients.locations`). */
  locations: ClientLocation[];
}

/** One tracked query — the exact prompt text posed to every engine. */
export interface DerivedQuery {
  /** Exact text sent to engines and stored verbatim in `visibility_results.prompt`. */
  prompt: string;
  /** The playbook template this came from (trace-back key). */
  template: string;
  intents: PromptIntent[];
  priority: PromptLibraryEntry["priority"];
  /**
   * Market label when the query is location-instantiated (the location's
   * name), null for market-independent queries.
   */
  location: string | null;
  /** Geo context passed to the provider for location-instantiated queries. */
  geo?: CitationGeo;
}

/** A template we could NOT honestly instantiate, and why. */
export interface ExcludedTemplate {
  template: string;
  /**
   * The tokens we had no real value for (normalized), plus the pseudo-tokens
   * "city" / "near me" when the template needs a location and the client has
   * none.
   */
  unresolved: string[];
}

/** The derived query set — the honest, structural derivation report. */
export interface DerivedQuerySet {
  vertical: Vertical;
  playbookVersion: string;
  /** The tracked queries, in stable priority order (see module header). */
  queries: DerivedQuery[];
  /** Templates excluded because substitution would have meant inventing data. */
  excluded: ExcludedTemplate[];
  /** Queries dropped by {@link MAX_TRACKED_QUERIES} (0 = none dropped). */
  dropped: number;
}

/* ------------------------------------------------------------------ */
/* Derivation                                                          */
/* ------------------------------------------------------------------ */

function normalizeToken(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Distinct normalized tokens, in order of first appearance. */
function templateTokens(template: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const token = normalizeToken(match[1]);
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

/** Usable market labels: trimmed location names, first-seen casing kept. */
function marketLabels(locations: ClientLocation[]): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const location of locations) {
    const label = typeof location?.name === "string" ? location.name.trim() : "";
    if (label === "" || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    labels.push(label);
  }
  return labels;
}

function instantiate(
  template: string,
  clientName: string,
  market: string | null
): string {
  return template.replace(PLACEHOLDER, (match, rawToken: string) => {
    const token = normalizeToken(rawToken);
    if (ENTITY_TOKENS.has(token)) return clientName;
    if (token === LOCATION_TOKEN && market !== null) return market;
    /* istanbul ignore next -- unreachable for included templates */
    return match;
  });
}

/**
 * Derive the tracked query set from the loaded playbook + the client facts.
 * Pure and deterministic; see the module header for the honesty rules.
 */
export function deriveQuerySet(
  playbook: Playbook,
  client: TrackedClientFacts
): DerivedQuerySet {
  const clientName = typeof client.name === "string" ? client.name.trim() : "";
  const markets = marketLabels(client.locations ?? []);

  // Stable template order: high priority first, then playbook order.
  const templates = playbook.prompt_library
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        PRIORITY_RANK[a.entry.priority] - PRIORITY_RANK[b.entry.priority] ||
        a.index - b.index
    );

  const queries: DerivedQuery[] = [];
  const excluded: ExcludedTemplate[] = [];
  const seenQueries = new Set<string>();

  for (const { entry } of templates) {
    const tokens = templateTokens(entry.prompt);
    const unresolved = tokens.filter(
      (token) =>
        !(ENTITY_TOKENS.has(token) && clientName !== "") &&
        token !== LOCATION_TOKEN
    );
    if (unresolved.length > 0) {
      excluded.push({ template: entry.prompt, unresolved });
      continue;
    }

    const needsMarket =
      tokens.includes(LOCATION_TOKEN) || NEAR_ME.test(entry.prompt);
    if (needsMarket && markets.length === 0) {
      excluded.push({
        template: entry.prompt,
        unresolved: [
          ...(tokens.includes(LOCATION_TOKEN) ? [LOCATION_TOKEN] : []),
          ...(NEAR_ME.test(entry.prompt) ? ["near me"] : []),
        ],
      });
      continue;
    }

    const variants: Array<{ prompt: string; market: string | null }> =
      needsMarket
        ? markets.map((market) => ({
            prompt: instantiate(entry.prompt, clientName, market),
            market,
          }))
        : [{ prompt: instantiate(entry.prompt, clientName, null), market: null }];

    for (const variant of variants) {
      const key = `${variant.prompt.toLowerCase()} ${variant.market ?? ""}`;
      if (seenQueries.has(key)) continue;
      seenQueries.add(key);
      queries.push({
        prompt: variant.prompt,
        template: entry.prompt,
        intents: [...entry.intents],
        priority: entry.priority,
        location: variant.market,
        ...(variant.market !== null ? { geo: { market: variant.market } } : {}),
      });
    }
  }

  // Honest truncation: drop from the END (lowest-priority tail), report count.
  const dropped = Math.max(0, queries.length - MAX_TRACKED_QUERIES);
  return {
    vertical: playbook.vertical,
    playbookVersion: playbook.version,
    queries: dropped > 0 ? queries.slice(0, MAX_TRACKED_QUERIES) : queries,
    excluded,
    dropped,
  };
}
