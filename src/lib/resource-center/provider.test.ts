/**
 * M18 — the two scriptable vendor fakes journal their calls + honour scripts /
 * failNext, so the engine tests can prove scope + sources reached the provider
 * and exercise the unavailable paths with NO network and NO SDK.
 */

import { describe, expect, it } from "vitest";
import { ScriptedAnswerProvider, ScriptedWebSearchProvider } from "./provider";
import type { AnswerRequest, WebSearchRequest } from "./types";

const SCOPE = {
  vertical: "real-estate" as const,
  playbookVersion: "1.0.0",
  citationSources: ["zillow.com"],
  topicAnchors: ["buying process"],
  entitySignals: ["author box"],
  complianceRef: "skill://compliance-ruleset/real-estate",
};

function req(question: string): AnswerRequest {
  return { question, scope: SCOPE, sources: [{ title: "T", url: "https://a.com", snippet: "s" }] };
}

describe("ScriptedAnswerProvider", () => {
  it("journals calls + returns the first matching script", async () => {
    const p = new ScriptedAnswerProvider().script({
      questionMatch: "escrow",
      result: (r) => ({
        answer: `re:${r.scope.vertical}`,
        citedSourceUrls: [r.sources[0].url],
        answered: true,
        selfConfidence: "high",
        raw: {},
      }),
    });
    const out = await p.answer(req("what is escrow"));
    expect(out.answer).toBe("re:real-estate");
    expect(out.citedSourceUrls).toEqual(["https://a.com"]);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].question).toBe("what is escrow");
  });

  it("failNext throws once, then resumes scripted behaviour", async () => {
    const p = new ScriptedAnswerProvider().failNext(new Error("deferred"));
    await expect(p.answer(req("q"))).rejects.toThrow("deferred");
    const out = await p.answer(req("q2")); // default answer echoes first source
    expect(out.answered).toBe(true);
  });
});

describe("ScriptedWebSearchProvider", () => {
  it("journals calls, honours maxResults, and failNext throws once", async () => {
    const p = new ScriptedWebSearchProvider().script({
      results: [
        { title: "A", url: "https://a.com", snippet: "1" },
        { title: "B", url: "https://b.com", snippet: "2" },
      ],
    });
    const request: WebSearchRequest = {
      query: "q",
      vertical: "real-estate",
      preferredSources: [],
      maxResults: 1,
    };
    const out = await p.search(request);
    expect(out).toHaveLength(1); // capped by maxResults
    expect(p.calls[0].query).toBe("q");

    const f = new ScriptedWebSearchProvider().failNext();
    await expect(f.search(request)).rejects.toThrow();
  });

  it("returns [] for an unscripted query (honest 'found nothing')", async () => {
    const p = new ScriptedWebSearchProvider();
    expect(await p.search({ query: "x", vertical: "real-estate", preferredSources: [], maxResults: 5 })).toEqual([]);
  });
});
