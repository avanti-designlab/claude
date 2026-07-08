/**
 * Secrets-vault seam tests (doc 03 §5, doc 04 §5): a resolved VendorCredential
 * is usable inside an adapter but NEVER leaks through logs, string
 * interpolation, or JSON serialization.
 */

import util from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VendorCredential, type SecretsResolver } from "./index";

const SECRET = "wp-app-password-super-secret";

describe("VendorCredential masking", () => {
  it("reveal() returns the raw secret for in-adapter use", () => {
    expect(new VendorCredential(SECRET).reveal()).toBe(SECRET);
  });

  it("never exposes the secret via toString / template interpolation", () => {
    const cred = new VendorCredential(SECRET);
    expect(String(cred)).toBe("VendorCredential(***)");
    expect(`${cred}`).not.toContain(SECRET);
  });

  it("never exposes the secret via JSON.stringify (log safety)", () => {
    const cred = new VendorCredential(SECRET);
    expect(JSON.stringify({ auth: cred })).not.toContain(SECRET);
    expect(JSON.stringify(cred)).toBe('"***"');
  });

  // The MAJOR 1.2 finding: a TS `private` field compiles to a plain enumerable
  // property, so `console.log(cred)` / `util.inspect(cred)` printed the raw
  // secret. This proves the leak is closed on EVERY standard logging path.
  describe("secret never prints through any standard logging path", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("leaks through none of util.inspect / String / JSON / template / console.log", () => {
      const cred = new VendorCredential(SECRET);

      // console.log's own formatting path (util.inspect with default opts).
      const inspected = util.inspect(cred);
      // Even deep inspection cannot reach the private field.
      const inspectedDeep = util.inspect(cred, { showHidden: true, depth: null });
      // Actual console.log output, captured.
      const spy = vi.spyOn(console, "log").mockImplementation(() => {});
      console.log(cred);
      console.log("credential:", cred, { auth: cred });
      const logged = spy.mock.calls
        .map((args) => util.format(...args))
        .join("\n");

      const surfaces: Record<string, string> = {
        "util.inspect": inspected,
        "util.inspect(showHidden)": inspectedDeep,
        "console.log": logged,
        String: String(cred),
        template: `${cred}`,
        "JSON.stringify": JSON.stringify(cred),
        "JSON.stringify(wrapped)": JSON.stringify({ auth: cred }),
      };
      for (const [surface, out] of Object.entries(surfaces)) {
        expect(out, `${surface} must not leak the secret`).not.toContain(SECRET);
      }

      // The masked forms are what actually appears.
      expect(inspected).toBe("VendorCredential(***)");
      expect(logged).toContain("VendorCredential(***)");
      // The secret is not even an enumerable/named own property (root cause).
      expect(Object.keys(cred)).not.toContain("secret");
      expect(Object.getOwnPropertyNames(cred)).not.toContain("secret");

      // ...yet the real value is still reachable for the adapter that needs it.
      expect(cred.reveal()).toBe(SECRET);
    });
  });
});

describe("SecretsResolver contract", () => {
  it("resolves an auth_ref to a credential at call time, tenant-scoped", async () => {
    // A stand-in resolver: real vault-backed resolvers land with the adapters.
    const vault: Record<string, string> = { "vault://wp/c1": SECRET };
    const resolver: SecretsResolver = {
      async resolve(authRef, scope) {
        expect(scope.tenantId).toBe("t1");
        return new VendorCredential(vault[authRef] ?? "");
      },
    };
    const cred = await resolver.resolve("vault://wp/c1", {
      tenantId: "t1",
      clientId: "c1",
    });
    expect(cred.reveal()).toBe(SECRET);
    // The resolved value is not accidentally serializable.
    expect(JSON.stringify(cred)).not.toContain(SECRET);
  });
});
