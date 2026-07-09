/**
 * M18 — the deferred vendor seams fail CLOSED with content-free sentinels and
 * import no Anthropic/web-search SDK. The answer adapter rejects (→ honest
 * answer_unavailable); the web-search adapter is null (→ no fabricated sources).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  RESOURCE_ANSWER_DEFERRED,
  resolveAnswerProvider,
  resolveWebSearchProvider,
} from "./live-provider";

describe("resolveAnswerProvider (deferred Anthropic adapter)", () => {
  it("returns a provider that fails closed with the content-free sentinel", async () => {
    const provider = resolveAnswerProvider();
    expect(provider.vendor).toBe("anthropic-deferred");
    await expect(provider.answer({} as never)).rejects.toThrow(RESOURCE_ANSWER_DEFERRED);
    // The sentinel carries no question/scope/client data.
    expect(RESOURCE_ANSWER_DEFERRED).not.toMatch(/question|client|tenant|prompt/i);
  });
});

describe("resolveWebSearchProvider (deferred web-search adapter)", () => {
  it("returns null (no vendor yet) — the engine runs with no fabricated sources", () => {
    expect(resolveWebSearchProvider()).toBeNull();
  });
});
