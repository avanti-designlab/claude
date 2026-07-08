/**
 * Secrets-vault seam tests (doc 03 §5, doc 04 §5): a resolved VendorCredential
 * is usable inside an adapter but NEVER leaks through logs, string
 * interpolation, or JSON serialization.
 */

import { describe, expect, it } from "vitest";
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
