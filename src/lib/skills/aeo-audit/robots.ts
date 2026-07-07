/**
 * aeo-audit — minimal robots.txt parser for the AI-crawler-access check (M5).
 *
 * Implements the parts of the Google robots.txt spec that matter here:
 * - user-agent groups (consecutive `User-agent:` lines share one rule group)
 * - most-specific group wins: the group whose user-agent token is the longest
 *   match for the bot name; `*` applies only when no named group matches
 * - within a group, the longest-path rule wins; `Allow` beats `Disallow` on ties
 * - `*` wildcard and `$` end-anchor in rule paths
 * - an empty `Disallow:` value means "allow everything"
 *
 * Pure parsing only — nothing here fetches anything.
 */

export interface RobotsRule {
  type: "allow" | "disallow";
  path: string;
}

export interface RobotsGroup {
  /** Lowercased user-agent tokens this group applies to. */
  userAgents: string[];
  rules: RobotsRule[];
}

/** The four AI crawlers the rubric requires access for (SKILL.md check 5). */
export const AI_CRAWLER_BOTS = [
  "GPTBot",
  "ClaudeBot",
  "PerplexityBot",
  "Google-Extended",
] as const;

export type AiCrawlerBot = (typeof AI_CRAWLER_BOTS)[number];

export function parseRobotsTxt(content: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  /** True while consecutive user-agent lines are still extending `current`. */
  let collectingAgents = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (directive === "user-agent") {
      if (!collectingAgents || current === null) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
        collectingAgents = true;
      }
      current.userAgents.push(value.toLowerCase());
    } else if (directive === "allow" || directive === "disallow") {
      collectingAgents = false;
      if (current !== null) {
        current.rules.push({ type: directive, path: value });
      }
    } else {
      // sitemap / crawl-delay / unknown directives end an agent-collection run
      collectingAgents = false;
    }
  }
  return groups;
}

/** Longest user-agent token in `groups` matching `bot`, or null. */
function matchGroup(groups: RobotsGroup[], bot: string): RobotsGroup | null {
  const botLower = bot.toLowerCase();
  let best: { group: RobotsGroup; length: number } | null = null;
  let wildcard: RobotsGroup | null = null;

  for (const group of groups) {
    for (const agent of group.userAgents) {
      if (agent === "*") {
        wildcard = wildcard ?? group;
        continue;
      }
      // Spec: the crawler name must start with the group token (prefix match).
      if (botLower.startsWith(agent) && (best === null || agent.length > best.length)) {
        best = { group, length: agent.length };
      }
    }
  }
  return best?.group ?? wildcard;
}

function ruleMatches(rulePath: string, path: string): boolean {
  if (rulePath === "") return false; // empty Disallow = allow all (no match)
  const anchored = rulePath.endsWith("$");
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}${anchored ? "$" : ""}`);
  return regex.test(path);
}

/**
 * Is `bot` allowed to fetch `path` under this robots.txt?
 * `robotsTxt === null` (no robots.txt served) allows everything.
 */
export function isBotAllowed(robotsTxt: string | null, bot: string, path: string): boolean {
  if (robotsTxt === null) return true;
  const group = matchGroup(parseRobotsTxt(robotsTxt), bot);
  if (group === null) return true;

  let winner: RobotsRule | null = null;
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    if (
      winner === null ||
      rule.path.length > winner.path.length ||
      (rule.path.length === winner.path.length && rule.type === "allow" && winner.type === "disallow")
    ) {
      winner = rule;
    }
  }
  return winner === null || winner.type === "allow";
}
