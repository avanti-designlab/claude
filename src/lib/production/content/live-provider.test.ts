/**
 * The deferred vendor seam fails CLOSED with a content-free sentinel — it never
 * silently produces generic-voice content, and it imports no Anthropic SDK.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CONTENT_GENERATION_DEFERRED, resolveContentProvider } from "./live-provider";

describe("resolveContentProvider (deferred Anthropic adapter)", () => {
  it("returns a provider that fails closed with the content-free sentinel", async () => {
    const provider = resolveContentProvider();
    expect(provider.vendor).toBe("anthropic-deferred");
    await expect(provider.generate({} as never)).rejects.toThrow(CONTENT_GENERATION_DEFERRED);
    // The sentinel carries no prompt/spec/client data.
    expect(CONTENT_GENERATION_DEFERRED).not.toMatch(/prompt|client|tenant/i);
  });
});
