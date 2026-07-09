/**
 * ContentGenerationProvider port + the scriptable in-memory fake.
 *
 * The fake is the ONLY provider tested code uses (no Anthropic SDK, no network —
 * task constraint). Pins: journaling of the exact specs the pipeline built,
 * scripting by content type / topic, spec-derived results (so a test can prove a
 * constraint reached the provider), fault injection, and the unscripted default.
 */

import { describe, expect, it } from "vitest";
import { ScriptedContentProvider } from "./provider";
import type { ContentGenerationSpec } from "./types";

function spec(partial: Partial<ContentGenerationSpec> = {}): ContentGenerationSpec {
  return {
    contentType: "blog",
    topic: "buying property in the city",
    groundingFacts: [],
    voice: { descriptors: [], samples: [], do: [], dont: [] },
    playbook: { vertical: "real-estate", templates: [], schemaProfile: [], entitySignals: [], targetPrompt: null },
    complianceGuardrails: [],
    ...partial,
  };
}

describe("ScriptedContentProvider", () => {
  it("journals every spec it is asked to generate", async () => {
    const p = new ScriptedContentProvider();
    await p.generate(spec({ topic: "one" }));
    await p.generate(spec({ topic: "two" }));
    expect(p.calls.map((c) => c.topic)).toEqual(["one", "two"]);
  });

  it("returns an on-topic default for an unscripted spec", async () => {
    const p = new ScriptedContentProvider();
    const res = await p.generate(spec({ topic: "mortgages" }));
    expect(res.body).toContain("mortgages");
    expect(res.raw).toMatchObject({ scripted: false });
  });

  it("matches a rule by content type and topic substring; first match wins", async () => {
    const p = new ScriptedContentProvider()
      .script({ contentType: "faq", result: { title: "FAQ", body: "faq body", raw: {} } })
      .script({ topicMatch: "visa", result: { title: "Visa", body: "visa body", raw: {} } });

    expect((await p.generate(spec({ contentType: "faq", topic: "visa" }))).body).toBe("faq body");
    expect((await p.generate(spec({ contentType: "blog", topic: "golden visa" }))).body).toBe("visa body");
    expect((await p.generate(spec({ contentType: "blog", topic: "taxes" }))).body).toContain("taxes");
  });

  it("supports a spec-derived result (proves constraints reached the provider)", async () => {
    const p = new ScriptedContentProvider().script({
      result: (s) => ({
        title: s.topic,
        body: `voice=${s.voice.descriptors.join("/")} target=${s.playbook.targetPrompt}`,
        raw: {},
      }),
    });
    const res = await p.generate(
      spec({
        voice: { descriptors: ["confident", "precise"], samples: [], do: [], dont: [] },
        playbook: { vertical: "real-estate", templates: [], schemaProfile: [], entitySignals: [], targetPrompt: "who is X" },
      }),
    );
    expect(res.body).toBe("voice=confident/precise target=who is X");
  });

  it("failNext throws exactly once, then resumes normal scripting", async () => {
    const p = new ScriptedContentProvider().failNext(new Error("vendor down"));
    await expect(p.generate(spec())).rejects.toThrow("vendor down");
    // Recorded the attempt, and the next call succeeds.
    expect(p.calls).toHaveLength(1);
    await expect(p.generate(spec())).resolves.toBeTruthy();
  });
});
