import { describe, expect, it } from "vitest";
import { authorizeProcessorRequest, presentedSecret, PROCESSOR_SECRET_ENV, secretsMatch } from "./auth";

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

describe("secretsMatch (constant-time, length-safe)", () => {
  it("matches identical secrets", () => {
    expect(secretsMatch("abc123", "abc123")).toBe(true);
  });
  it("rejects different secrets", () => {
    expect(secretsMatch("abc123", "abc124")).toBe(false);
  });
  it("does NOT throw on length mismatch (the sha256 pre-hash guarantees equal length)", () => {
    expect(() => secretsMatch("short", "a-much-longer-secret-value")).not.toThrow();
    expect(secretsMatch("short", "a-much-longer-secret-value")).toBe(false);
  });
});

describe("presentedSecret", () => {
  it("reads Authorization: Bearer <secret>", () => {
    expect(presentedSecret(headers({ authorization: "Bearer s3cr3t" }))).toBe("s3cr3t");
  });
  it("reads x-runs-secret", () => {
    expect(presentedSecret(headers({ "x-runs-secret": "s3cr3t" }))).toBe("s3cr3t");
  });
  it("is null when absent or empty", () => {
    expect(presentedSecret(headers())).toBeNull();
    expect(presentedSecret(headers({ authorization: "Bearer   " }))).toBeNull();
  });
});

describe("authorizeProcessorRequest (A2 timing-safe shared-secret auth)", () => {
  const CONFIGURED: Record<string, string | undefined> = { [PROCESSOR_SECRET_ENV]: "the-real-secret" };

  it("env-UNSET fails CLOSED with a NON-500 refusal (503 unconfigured)", () => {
    const res = authorizeProcessorRequest(headers({ authorization: "Bearer the-real-secret" }), {});
    expect(res).toEqual({ ok: false, status: 503, reason: "unconfigured" });
  });

  it("missing presented secret → 401", () => {
    const res = authorizeProcessorRequest(headers(), CONFIGURED);
    expect(res).toEqual({ ok: false, status: 401, reason: "unauthorized" });
  });

  it("WRONG secret → 401", () => {
    const res = authorizeProcessorRequest(headers({ authorization: "Bearer wrong" }), CONFIGURED);
    expect(res).toEqual({ ok: false, status: 401, reason: "unauthorized" });
  });

  it("CORRECT secret → ok", () => {
    const res = authorizeProcessorRequest(headers({ authorization: "Bearer the-real-secret" }), CONFIGURED);
    expect(res).toEqual({ ok: true });
  });

  it("accepts the x-runs-secret header too", () => {
    const res = authorizeProcessorRequest(headers({ "x-runs-secret": "the-real-secret" }), CONFIGURED);
    expect(res).toEqual({ ok: true });
  });
});
