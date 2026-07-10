import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Neutralise the server-only marker + inject the env getters (the real module
// imports "server-only", which throws in the default vitest run).
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ secret: "the-secret" as string | null }));
vi.mock("@/lib/env.server", () => ({
  getRunsProcessorSecret: () => state.secret,
  getRunsProcessorBaseUrl: () => "http://127.0.0.1:3000",
}));

import { kickProcessor } from "./kick";

describe("kickProcessor (A9 — non-blocking, failure-tolerant)", () => {
  beforeEach(() => {
    state.secret = "the-secret";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires a POST with the bearer secret at the processor endpoint (redirect:error)", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    kickProcessor("process");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("http://127.0.0.1:3000/api/runs/process");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer the-secret");
    expect(init.redirect).toBe("error");
  });

  it("NEVER throws even if fetch rejects — kick failure must not surface", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    expect(() => kickProcessor("process")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0)); // let the swallowed rejection settle
  });

  it("skips entirely when the secret is unconfigured (sweeper backstop covers pickup)", () => {
    state.secret = null;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    kickProcessor("process");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("can target the sweep endpoint", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    kickProcessor("sweep");
    expect(fetchSpy.mock.calls[0][0]).toBe("http://127.0.0.1:3000/api/runs/sweep");
  });
});
