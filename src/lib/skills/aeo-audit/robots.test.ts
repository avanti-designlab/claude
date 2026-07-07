import { describe, expect, it } from "vitest";
import { AI_CRAWLER_BOTS, isBotAllowed, parseRobotsTxt } from "./robots";

describe("parseRobotsTxt", () => {
  it("groups consecutive user-agent lines into one rule group", () => {
    const groups = parseRobotsTxt("User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /private\n");
    expect(groups).toHaveLength(1);
    expect(groups[0].userAgents).toEqual(["gptbot", "claudebot"]);
    expect(groups[0].rules).toEqual([{ type: "disallow", path: "/private" }]);
  });

  it("starts a new group after rules and ignores comments/blank lines", () => {
    const groups = parseRobotsTxt(
      "# block AI\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: / # everyone else\n",
    );
    expect(groups).toHaveLength(2);
    expect(groups[1].userAgents).toEqual(["*"]);
    expect(groups[1].rules).toEqual([{ type: "allow", path: "/" }]);
  });
});

describe("isBotAllowed", () => {
  it("allows everything when robots.txt is absent (null)", () => {
    for (const bot of AI_CRAWLER_BOTS) {
      expect(isBotAllowed(null, bot, "/")).toBe(true);
    }
  });

  it("blocks a specifically disallowed bot but not others", () => {
    const robots = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n";
    expect(isBotAllowed(robots, "GPTBot", "/")).toBe(false);
    expect(isBotAllowed(robots, "ClaudeBot", "/")).toBe(true);
  });

  it("prefers the specific group over the wildcard group", () => {
    const robots = "User-agent: *\nDisallow: /\n\nUser-agent: PerplexityBot\nAllow: /\n";
    expect(isBotAllowed(robots, "PerplexityBot", "/page")).toBe(true);
    expect(isBotAllowed(robots, "GPTBot", "/page")).toBe(false);
  });

  it("applies longest-path-rule precedence with Allow beating Disallow on ties", () => {
    const robots = "User-agent: *\nDisallow: /blog\nAllow: /blog/public\n";
    expect(isBotAllowed(robots, "GPTBot", "/blog/secret")).toBe(false);
    expect(isBotAllowed(robots, "GPTBot", "/blog/public/post")).toBe(true);
    const tie = "User-agent: *\nDisallow: /a\nAllow: /a\n";
    expect(isBotAllowed(tie, "GPTBot", "/a")).toBe(true);
  });

  it("treats an empty Disallow value as allow-all", () => {
    expect(isBotAllowed("User-agent: *\nDisallow:\n", "ClaudeBot", "/anything")).toBe(true);
  });

  it("supports * wildcards and $ end anchors in rule paths", () => {
    const robots = "User-agent: *\nDisallow: /*.pdf$\n";
    expect(isBotAllowed(robots, "GPTBot", "/files/report.pdf")).toBe(false);
    expect(isBotAllowed(robots, "GPTBot", "/files/report.pdf.html")).toBe(true);
  });

  it("matches Google-Extended as a named token", () => {
    const robots = "User-agent: Google-Extended\nDisallow: /\n";
    expect(isBotAllowed(robots, "Google-Extended", "/")).toBe(false);
    expect(isBotAllowed(robots, "GPTBot", "/")).toBe(true);
  });
});
