/**
 * Provider-agnostic connector interfaces (doc 04 §7; doc 07 §1.2) —
 * normalization + test-double behavior.
 *
 * What must hold: modules see ONLY the normalized shapes; vendor payloads
 * never leak into storage; the fakes exercise success, vendor-refusal, and
 * transport-failure paths so M3/M11 can be built against them.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryCitationDataProvider,
  InMemorySocialPostingProvider,
  toVisibilityResultInsert,
  UNCITED_RESULT,
  type CitationPromptRequest,
  type CitationPromptResult,
} from "./index";

const SCOPE = { tenantId: "tenant-1", clientId: "client-1" };

const CITED: CitationPromptResult = {
  cited: true,
  position: 2,
  sentiment: "positive",
  citedSource: "https://client.example.com/guide",
  raw: { vendor_field: "opaque", nested: { blob: true } },
};

function req(overrides: Partial<CitationPromptRequest> = {}): CitationPromptRequest {
  return { engine: "chatgpt", prompt: "best real estate advisor in san diego", ...overrides };
}

describe("toVisibilityResultInsert (vendor-independent normalization)", () => {
  it("maps a cited result onto the visibility_results contract columns", () => {
    const row = toVisibilityResultInsert(SCOPE, req(), CITED);
    expect(row).toEqual({
      tenant_id: "tenant-1",
      client_id: "client-1",
      engine: "chatgpt",
      prompt: "best real estate advisor in san diego",
      cited: true,
      position: 2,
      sentiment: "positive",
      cited_source: "https://client.example.com/guide",
    });
  });

  it("never persists the raw vendor payload", () => {
    const row = toVisibilityResultInsert(SCOPE, req(), CITED);
    expect(JSON.stringify(row)).not.toContain("vendor_field");
    expect(Object.keys(row)).not.toContain("raw");
  });

  it("nulls position for uncited results even if the vendor sent one", () => {
    const row = toVisibilityResultInsert(SCOPE, req(), { ...UNCITED_RESULT, position: 4 });
    expect(row.cited).toBe(false);
    expect(row.position).toBeNull();
  });

  it("nulls positions that violate the contract CHECK (position >= 1, integer)", () => {
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      const row = toVisibilityResultInsert(SCOPE, req(), { ...CITED, position: bad });
      expect(row.position).toBeNull();
    }
  });

  it("rejects unknown engines and empty prompts (fail loud, not stored)", () => {
    expect(() =>
      toVisibilityResultInsert(
        SCOPE,
        { ...req(), engine: "bing" as never },
        CITED
      )
    ).toThrow(/unknown visibility engine/);
    expect(() => toVisibilityResultInsert(SCOPE, req({ prompt: "  " }), CITED)).toThrow(
      /non-empty/
    );
  });
});

describe("InMemoryCitationDataProvider", () => {
  it("returns scripted results by engine + prompt match, first rule wins", async () => {
    const provider = new InMemoryCitationDataProvider()
      .script({ engine: "perplexity", promptMatch: "advisor", result: CITED })
      .script({ promptMatch: /.*/, result: UNCITED_RESULT });

    await expect(
      provider.runPrompt(req({ engine: "perplexity" }))
    ).resolves.toEqual(CITED);
    // Same prompt, different engine → falls through to the catch-all rule.
    await expect(provider.runPrompt(req({ engine: "gemini" }))).resolves.toEqual(
      UNCITED_RESULT
    );
  });

  it("defaults to not-cited for unscripted prompts and journals every call", async () => {
    const provider = new InMemoryCitationDataProvider();
    const result = await provider.runPrompt(req());
    expect(result.cited).toBe(false);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].prompt).toContain("advisor");
  });

  it("failNext rejects exactly once (transport-failure path)", async () => {
    const provider = new InMemoryCitationDataProvider().failNext(new Error("429"));
    await expect(provider.runPrompt(req())).rejects.toThrow("429");
    await expect(provider.runPrompt(req())).resolves.toEqual(UNCITED_RESULT);
  });
});

describe("InMemorySocialPostingProvider", () => {
  const request = {
    account: { platform: "instagram", accountRef: "acct-9" },
    asset: { url: "https://cdn.example.com/post.png", type: "image" as const },
    caption: "Open house this Saturday.",
    when: "2026-07-10T17:00:00Z",
  };

  it("schedules and journals with a provider post id", async () => {
    const provider = new InMemorySocialPostingProvider();
    const receipt = await provider.schedule(request);
    expect(receipt.status).toBe("scheduled");
    expect(receipt.postId).toMatch(/in-memory-post-/);
    expect(provider.posts).toHaveLength(1);
  });

  it("fails empty posts and unparseable schedule times", async () => {
    const provider = new InMemorySocialPostingProvider();
    await expect(
      provider.schedule({ ...request, caption: " ", asset: undefined })
    ).resolves.toMatchObject({ status: "failed", postId: null });
    await expect(provider.schedule({ ...request, when: "someday" })).resolves.toMatchObject(
      { status: "failed", postId: null }
    );
  });

  it("declineNext models a vendor policy refusal exactly once", async () => {
    const provider = new InMemorySocialPostingProvider().declineNext("blocked: alcohol policy");
    const refused = await provider.schedule(request);
    expect(refused).toEqual({
      status: "failed",
      postId: null,
      detail: "blocked: alcohol policy",
    });
    await expect(provider.schedule(request)).resolves.toMatchObject({ status: "scheduled" });
  });

  it("failNext rejects exactly once (transport-failure path)", async () => {
    const provider = new InMemorySocialPostingProvider().failNext(new Error("gateway down"));
    await expect(provider.schedule(request)).rejects.toThrow("gateway down");
    await expect(provider.schedule(request)).resolves.toMatchObject({ status: "scheduled" });
  });
});
