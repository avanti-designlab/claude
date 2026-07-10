/**
 * ensureWebsiteProperty suite — the idempotent property-row half of the
 * onboarding replay semantics. Pins: fresh insert (connection_method 'none',
 * NEVER auth_ref), no-op on an exact match, UPDATE-THROUGH on divergence
 * (replay idempotency), and honest ok:false + redacted telemetry on failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { ensureWebsiteProperty, type Supabase } from "./properties";

vi.mock("server-only", () => ({}));

const TENANT = "t1";
const CLIENT = "11111111-1111-4111-8111-111111111111";
const PROP = "22222222-2222-4222-8222-222222222222";
const WEBSITE = { url: "https://site.com", platform: "wordpress" as const };

/** The fake surface is a structural subset of the Supabase client; the write
 *  paths only use `.from(...)`. Cast at the seam, exactly like the mocked
 *  createClient does for the action suites. */
function client(s: FakeScript) {
  const fake = fakePostgrest(s);
  return { ...fake, client: fake.client as unknown as Supabase };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

describe("ensureWebsiteProperty", () => {
  it("FRESH: inserts a website with connection_method 'none' and NEVER auth_ref", async () => {
    const fake = client({ properties: { select: { data: [] }, insert: { data: { id: PROP } } } });
    const res = await ensureWebsiteProperty(fake.client, TENANT, CLIENT, WEBSITE);
    expect(res).toEqual({ ok: true, property: { id: PROP, url: WEBSITE.url, platform: WEBSITE.platform } });
    const values = fake.inserts[0].values as Record<string, unknown>;
    expect(values).toMatchObject({
      tenant_id: TENANT,
      client_id: CLIENT,
      type: "website",
      platform: "wordpress",
      url: "https://site.com",
      connection_method: "none",
    });
    expect("auth_ref" in values).toBe(false);
  });

  it("IDEMPOTENT MATCH: an existing identical website is returned with no insert/update", async () => {
    const fake = client({
      properties: { select: { data: [{ id: PROP, url: WEBSITE.url, platform: WEBSITE.platform }] } },
    });
    const res = await ensureWebsiteProperty(fake.client, TENANT, CLIENT, WEBSITE);
    expect(res).toEqual({ ok: true, property: { id: PROP, url: WEBSITE.url, platform: WEBSITE.platform } });
    expect(fake.inserts).toHaveLength(0);
    expect(fake.updates).toHaveLength(0);
  });

  it("REPLAY DIVERGENCE: an existing website with a different url is UPDATED-THROUGH (never stranded)", async () => {
    const fake = client({
      properties: {
        // The first attempt persisted an OLD url; the replay carries a new one.
        select: { data: [{ id: PROP, url: "https://old.com", platform: "wix" }] },
        update: { data: { id: PROP } },
      },
    });
    const res = await ensureWebsiteProperty(fake.client, TENANT, CLIENT, WEBSITE);
    expect(res).toEqual({ ok: true, property: { id: PROP, url: WEBSITE.url, platform: WEBSITE.platform } });
    expect(fake.inserts).toHaveLength(0);
    expect(fake.updates[0].values).toEqual({ url: WEBSITE.url, platform: WEBSITE.platform });
    expect(fake.updates[0].filters).toEqual({ tenant_id: TENANT, id: PROP });
  });

  it("reconciles the OLDEST website (the onboarding row) when several exist", async () => {
    const fake = client({
      properties: {
        select: { data: [{ id: PROP, url: "https://old.com", platform: "wix" }, { id: "other", url: "https://b.com", platform: "webflow" }] },
        update: { data: { id: PROP } },
      },
    });
    await ensureWebsiteProperty(fake.client, TENANT, CLIENT, WEBSITE);
    expect(fake.updates[0].filters).toEqual({ tenant_id: TENANT, id: PROP });
  });

  it("a read failure returns ok:false with redacted telemetry (no url in the log)", async () => {
    const fake = client({ properties: { select: { error: { message: "https://leak.com boom", code: "PGRST301" } } } });
    const res = await ensureWebsiteProperty(fake.client, TENANT, CLIENT, WEBSITE);
    expect(res).toEqual({ ok: false });
    const line = consoleErrorSpy.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[property-write-failure\] stage=property_read code=PGRST301$/);
    expect(line).not.toContain("leak.com");
  });

  it("an insert failure returns ok:false", async () => {
    const fake = client({ properties: { select: { data: [] }, insert: { error: { message: "boom", code: "23505" } } } });
    expect(await ensureWebsiteProperty(fake.client, TENANT, CLIENT, WEBSITE)).toEqual({ ok: false });
  });
});
