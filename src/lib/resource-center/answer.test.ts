/**
 * M18 — the QA engine end to end (providers injected, no network/SDK). Proves:
 * the playbook scope + retrieved sources reach the answer provider; the answer is
 * graded honestly; a deferred/throwing answer provider is `answer_unavailable`;
 * an unavailable/throwing web search degrades to honest, ungrounded, playbook-only.
 */

import { describe, expect, it } from "vitest";
import { getPlaybook } from "@/lib/playbooks";
import { answerQuestion } from "./answer";
import { ScriptedAnswerProvider, ScriptedWebSearchProvider } from "./provider";
import type { Playbook } from "@/lib/types/playbook";

const playbook = getPlaybook("real-estate") as Playbook;

function search(results = [{ title: "NAR", url: "https://nar.realtor/g", snippet: "Escrow holds funds." }]) {
  return new ScriptedWebSearchProvider().script({ results });
}

describe("answerQuestion — playbook-scoped answering", () => {
  it("hands the playbook scope AND the retrieved sources to the answer provider", async () => {
    const web = search();
    const ans = new ScriptedAnswerProvider().script({
      result: (r) => ({
        answer: `In ${r.scope.vertical}: ${r.sources[0].snippet}`,
        citedSourceUrls: [r.sources[0].url],
        answered: true,
        selfConfidence: "high",
        raw: {},
      }),
    });
    const out = await answerQuestion(ans, web, { question: "what is escrow", playbook });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The provider saw the playbook scope (vertical + version) and the sources.
    expect(ans.calls[0].scope.vertical).toBe("real-estate");
    expect(ans.calls[0].scope.playbookVersion).toBe(playbook.version);
    expect(ans.calls[0].sources).toHaveLength(1);
    // The web-search port was queried with the vertical + the niche's preferred sources.
    expect(web.calls[0].vertical).toBe("real-estate");
    expect(web.calls[0].preferredSources.length).toBeGreaterThan(0);

    expect(out.result.answer.grounded).toBe(true);
    expect(out.result.answer.confidence).toBe("high");
    expect(out.result.vendor.answer).toBe("scripted-fake");
    expect(out.result.vendor.webSearch).toBe("scripted-fake");
  });

  it("flags a fabricated citation and demotes the answer to ungrounded", async () => {
    const ans = new ScriptedAnswerProvider().script({
      result: { answer: "x", citedSourceUrls: ["https://made-up.example"], answered: true, selfConfidence: "high", raw: {} },
    });
    const out = await answerQuestion(ans, search(), { question: "q", playbook });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.answer.grounded).toBe(false);
    expect(out.result.answer.unattributedCitations).toEqual(["https://made-up.example"]);
  });
});

describe("answerQuestion — provider-unavailable honesty", () => {
  it("answer provider throwing (deferred adapter) → answer_unavailable, scope still known", async () => {
    const ans = new ScriptedAnswerProvider().failNext(new Error("boom secret prompt"));
    const out = await answerQuestion(ans, search(), { question: "q", playbook });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("answer_unavailable");
    expect(out.scope.vertical).toBe("real-estate");
    expect(out.webSearchAvailable).toBe(true);
  });

  it("no web-search provider → retrieval empty by force, ungrounded/low, webSearchAvailable=false", async () => {
    const ans = new ScriptedAnswerProvider().script({
      result: { answer: "playbook-only answer", citedSourceUrls: [], answered: true, selfConfidence: "high", raw: {} },
    });
    const out = await answerQuestion(ans, null, { question: "q", playbook });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.answer.webSearchAvailable).toBe(false);
    expect(out.result.answer.grounded).toBe(false);
    expect(out.result.answer.confidence).toBe("low");
    expect(out.result.vendor.webSearch).toBeNull();
  });

  it("web search THROWING is a soft failure — still answers (ungrounded), never a 500", async () => {
    const web = new ScriptedWebSearchProvider().failNext(new Error("search boom"));
    const ans = new ScriptedAnswerProvider().script({
      result: { answer: "a", citedSourceUrls: [], answered: true, raw: {} },
    });
    const out = await answerQuestion(ans, web, { question: "q", playbook });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.answer.webSearchAvailable).toBe(false);
    expect(out.result.answer.grounded).toBe(false);
  });
});
