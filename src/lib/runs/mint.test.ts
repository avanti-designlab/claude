import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintRunJwt, RUN_JWT_TTL_SECONDS, SYSTEM_PROCESSOR_SUB } from "./mint";

const SECRET = "test-jwt-secret-not-a-real-one";

function decode(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: string } {
  const [h, p, s] = jwt.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")),
    signingInput: `${h}.${p}`,
    signature: s,
  };
}

describe("mintRunJwt — the A1 per-run tenant-scope token", () => {
  it("is a well-formed HS256 JWT whose signature verifies against the secret", () => {
    const jwt = mintRunJwt({ tenantId: "11111111-1111-1111-1111-111111111111", secret: SECRET, nowSeconds: 1_000 });
    const { header, signingInput, signature } = decode(jwt);
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    const expected = createHmac("sha256", SECRET).update(signingInput).digest("base64url");
    expect(signature).toBe(expected);
  });

  it("carries the run's tenant, the WRITER app role, and reserved role=authenticated", () => {
    const tenantId = "22222222-2222-2222-2222-222222222222";
    const { payload } = decode(mintRunJwt({ tenantId, secret: SECRET, nowSeconds: 1_000 }));
    expect(payload.tenant_id).toBe(tenantId);
    expect(payload.user_role).toBe("operator"); // app writer role (app.is_writer())
    expect(payload.role).toBe("authenticated"); // PostgREST SET ROLE target
    expect(payload.aud).toBe("authenticated");
    expect(payload.sub).toBe(SYSTEM_PROCESSOR_SUB); // system identity, never a real user
  });

  it("is NEVER an agency_admin (least privilege) and carries no client_id", () => {
    const { payload } = decode(mintRunJwt({ tenantId: "t", secret: SECRET, nowSeconds: 1_000 }));
    expect(payload.user_role).not.toBe("agency_admin");
    expect(payload.user_role).not.toBe("platform_owner");
    expect(payload.client_id).toBeUndefined();
  });

  it("expires — exp = iat + ttl (short-lived)", () => {
    const { payload } = decode(mintRunJwt({ tenantId: "t", secret: SECRET, nowSeconds: 5_000 }));
    expect(payload.iat).toBe(5_000);
    expect(payload.exp).toBe(5_000 + RUN_JWT_TTL_SECONDS);
  });

  it("a token minted for tenant A does not verify under a different secret (isolation)", () => {
    const jwt = mintRunJwt({ tenantId: "A", secret: SECRET, nowSeconds: 1_000 });
    const { signingInput, signature } = decode(jwt);
    const wrong = createHmac("sha256", "different-secret").update(signingInput).digest("base64url");
    expect(signature).not.toBe(wrong);
  });
});
