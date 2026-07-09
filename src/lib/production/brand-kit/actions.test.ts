/**
 * M7 server-action suite (create / revise / read / version-history).
 *
 * Only the action's seams are mocked (verified-claims reader, Supabase server
 * client, next/navigation redirect); the role guard, uuid clamp, the input
 * clamp, the REAL frozen brand-kit-design-token skill, the REAL row mapping,
 * and the REAL locking all run. Pins the review-gated hard properties:
 *  - claim-sourced tenant on the persisted row (never client-supplied); the
 *    stored client_id comes from the RLS-scoped clients read;
 *  - a hostile payload (extra fields, forged tenant/version) is dead weight;
 *  - RLS-mirrored auth (operator may write, mirroring brand_kits_insert
 *    app.is_writer; client_viewer may READ, mirroring brand_kits_select);
 *  - locking/versioning: only LOCKED rows are persisted; a revision is a NEW
 *    version (N+1), never an in-place edit;
 *  - the B1 defense holds through the action (hostile font → refused, no write);
 *  - the honesty hard gate: an unresolvable-contrast kit is REFUSED, not locked;
 *  - redacted telemetry: one line, marker + stage + code, no payloads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { ingestBrandKit } from "./ingest";
import {
  createBrandKit,
  listBrandKitVersionHistory,
  readLockedBrandKit,
  reviseBrandKit,
  type CreateBrandKitInput,
} from "./actions";

/* ------------------------------------------------------------------ */
/* seams                                                               */
/* ------------------------------------------------------------------ */

const { getClaimsMock, createClientMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getClaims: getClaimsMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const CLIENT_ID = "4a9f3b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c";
const OPERATOR_CLAIMS = { tenantId: "tenant-1", role: "operator" as const, sub: "u1" };
const ADMIN_CLAIMS = { tenantId: "tenant-1", role: "agency_admin" as const, sub: "u2" };
const VIEWER_CLAIMS = { tenantId: "tenant-1", role: "client_viewer" as const, clientId: CLIENT_ID, sub: "u3" };

const TELEMETRY = /^\[brand-kit-write-failure\] stage=(brand_kit_insert|thrown) code=[A-Za-z0-9_]{1,16}$/;

const CLIENT_ROW = { id: CLIENT_ID };

/** A complete, well-formed locked `brand_kits` row for read/revise fixtures. */
function lockedRow(version = 2) {
  const res = ingestBrandKit({
    colors: { accent: "#2b6cff" },
    voice: { descriptors: ["confident"], samples: ["We build."] },
    logoUrl: "https://cdn/logo.svg",
  });
  if (!res.ok) throw new Error("fixture build failed");
  return {
    id: "kit-current",
    client_id: CLIENT_ID,
    version,
    locked: true,
    tokens: res.kit.tokens,
    voice_profile: res.kit.voice_profile,
    likeness_refs: res.kit.likeness_refs,
    assets: { logo_url: res.logoUrl, ingestion: res.report },
    created_at: "2026-07-09T00:00:00Z",
  };
}

function setup(script: FakeScript, claims: unknown = OPERATOR_CLAIMS) {
  const fake = fakePostgrest(script);
  getClaimsMock.mockResolvedValue(claims);
  createClientMock.mockResolvedValue(fake.client);
  return fake;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => {
    expect(call).toHaveLength(1);
    expect(typeof call[0]).toBe("string");
    return call[0] as string;
  });
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

const VALID_INPUT: CreateBrandKitInput = { clientId: CLIENT_ID, colors: { accent: "#2b6cff" } };

/* ------------------------------------------------------------------ */
/* createBrandKit — authz + claim-sourced scoping                      */
/* ------------------------------------------------------------------ */

describe("createBrandKit — authz (mirrors brand_kits_insert app.is_writer)", () => {
  it("client_viewer: forbidden, no Supabase client touched", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    const res = await createBrandKit(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "forbidden" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("operator IS allowed: the kit is built + persisted", async () => {
    const fake = setup(
      { clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [] }, insert: { data: { id: "kit-1" } } } },
      OPERATOR_CLAIMS,
    );
    const res = await createBrandKit(VALID_INPUT);
    expect(res.ok).toBe(true);
    expect(fake.inserts.map((i) => i.table)).toEqual(["brand_kits"]);
  });

  it("agency_admin IS allowed too", async () => {
    setup(
      { clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [] }, insert: { data: { id: "kit-1" } } } },
      ADMIN_CLAIMS,
    );
    const res = await createBrandKit(VALID_INPUT);
    expect(res.ok).toBe(true);
  });

  it("unauthenticated: NEXT_REDIRECT propagates, nothing touched", async () => {
    getClaimsMock.mockResolvedValue(null);
    await expect(createBrandKit(VALID_INPUT)).rejects.toThrow(/NEXT_REDIRECT:\/login/);
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("non-UUID clientId: not_found before any DB call", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    for (const bad of ["", "not-a-uuid", "42 or 1=1"]) {
      const res = await createBrandKit({ ...VALID_INPUT, clientId: bad });
      expect(res).toMatchObject({ ok: false, reason: "not_found" });
    }
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("client not visible under RLS: not_found (cross-tenant == nonexistent)", async () => {
    setup({ clients: { select: { data: null } } });
    const res = await createBrandKit(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("createBrandKit — claim-sourced tenant + hostile dead weight", () => {
  it("persists tenant_id from the CLAIM and client_id from the RLS-scoped read — forged fields ignored", async () => {
    const fake = setup(
      { clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [] }, insert: { data: { id: "kit-1" } } } },
      OPERATOR_CLAIMS,
    );
    // A hostile caller stuffs the payload with fields it must not control.
    const hostile = {
      clientId: CLIENT_ID,
      colors: { accent: "#2b6cff" },
      tenant_id: "attacker-tenant",
      client_id: "attacker-client",
      version: 99,
      locked: false,
    } as unknown as CreateBrandKitInput;
    const res = await createBrandKit(hostile);
    expect(res.ok).toBe(true);

    const row = fake.inserts.find((i) => i.table === "brand_kits")!.values as Record<string, unknown>;
    expect(row.tenant_id).toBe("tenant-1"); // claim-sourced, NOT "attacker-tenant"
    expect(row.client_id).toBe(CLIENT_ID); // RLS-read-sourced, NOT "attacker-client"
    expect(row.version).toBe(1); // library-managed, NOT 99
    expect(row.locked).toBe(true); // only locked captures are persisted
  });
});

/* ------------------------------------------------------------------ */
/* createBrandKit — build gates + versioning                           */
/* ------------------------------------------------------------------ */

describe("createBrandKit — build gates + versioning", () => {
  it("returns version 1 + the honesty report on success", async () => {
    setup({ clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [] }, insert: { data: { id: "kit-1" } } } });
    const res = await createBrandKit(VALID_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toBe(1);
    expect(res.brandKitId).toBe("kit-1");
    // Partial input → the report carries defaults + missing, surfaced live.
    expect(res.report.notes.length).toBeGreaterThan(0);
  });

  it("refuses when a kit already exists (revise instead) — no insert", async () => {
    const fake = setup({ clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [{ version: 2 }] } } });
    const res = await createBrandKit(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "already_exists" });
    expect(fake.inserts.some((i) => i.table === "brand_kits")).toBe(false);
  });

  it("a concurrent create that collides on the version constraint → already_exists", async () => {
    setup({
      clients: { select: { data: CLIENT_ROW } },
      brand_kits: { select: { data: [] }, insert: { error: { message: "dupe", code: "23505" } } },
    });
    const res = await createBrandKit(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "already_exists" });
  });

  it("HARD HONESTY GATE: an unresolvable-contrast kit is refused, never locked/persisted", async () => {
    const fake = setup({ clients: { select: { data: CLIENT_ROW } } });
    const res = await createBrandKit({
      clientId: CLIENT_ID,
      colors: { accent: "#e3a94f", surface: "#ffffff", surfaceRaised: "#14181f" },
    });
    expect(res).toMatchObject({ ok: false, reason: "contrast_unresolvable" });
    expect(fake.inserts.some((i) => i.table === "brand_kits")).toBe(false);
  });

  it("B1: a hostile font is refused with interface copy (not the skill message), no write", async () => {
    const fake = setup({ clients: { select: { data: CLIENT_ROW } } });
    const res = await createBrandKit({
      clientId: CLIENT_ID,
      colors: { accent: "#2b6cff" },
      typography: { body: 'Inter"; } body{display:none}' },
    });
    expect(res).toMatchObject({ ok: false, reason: "invalid_brand_input" });
    if (res.ok) return;
    // Interface voice — never echoes the skill's raw grammar error to the browser.
    expect(res.error).not.toContain("font-family");
    expect(fake.inserts.some((i) => i.table === "brand_kits")).toBe(false);
  });

  it("an oversized voice payload is refused by the clamp before the DB", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    const res = await createBrandKit({
      clientId: CLIENT_ID,
      colors: { accent: "#2b6cff" },
      voice: { samples: ["x".repeat(999999)] },
    } as CreateBrandKitInput);
    expect(res).toMatchObject({ ok: false, reason: "invalid_brand_input" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("B1 scale: the reviewer's hostile type-scale PoCs are refused with interface copy, no DB touched", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    const payloads = [
      { base: { size: "1rem; } body{display:none} .x{color:red", lineHeight: "1.5rem" } }, // hostile size value
      { "x; } body{display:none} .y{": { size: "1rem", lineHeight: "1.5rem" } }, // hostile key
      { base: { size: "1rem", lineHeight: "1.5rem", weight: "700; } body{}" } }, // hostile weight
    ];
    for (const scale of payloads) {
      const res = await createBrandKit({
        clientId: CLIENT_ID,
        colors: { accent: "#2b6cff" },
        typography: { scale },
      } as unknown as CreateBrandKitInput);
      expect(res).toMatchObject({ ok: false, reason: "invalid_brand_input" });
      if (res.ok) continue;
      // Interface voice — never echoes the raw hostile value or a skill string.
      expect(res.error).not.toContain("body{");
      expect(res.error).not.toContain("font-family");
    }
    // Refused by the clamp BEFORE any Supabase client is created — no row written.
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("a valid custom type scale ingests + locks (version 1 persisted)", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      brand_kits: { select: { data: [] }, insert: { data: { id: "kit-1" } } },
    });
    const res = await createBrandKit({
      clientId: CLIENT_ID,
      colors: { accent: "#2b6cff" },
      typography: { scale: { sm: { size: "0.875rem", lineHeight: "1.25rem" }, "2xl": { size: "2rem", lineHeight: "1.1", weight: 600 } } },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toBe(1);
    const row = fake.inserts.find((i) => i.table === "brand_kits")!.values as {
      locked: boolean;
      tokens: { typography: { scale: Record<string, unknown> } };
    };
    expect(row.locked).toBe(true);
    expect(Object.keys(row.tokens.typography.scale)).toEqual(["sm", "2xl"]);
  });
});

/* ------------------------------------------------------------------ */
/* reviseBrandKit — immutable next version                              */
/* ------------------------------------------------------------------ */

describe("reviseBrandKit — a change is a NEW version, never in place", () => {
  it("reads the current locked kit and inserts version N+1 (locked)", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      brand_kits: { select: { data: [lockedRow(2)] }, insert: { data: { id: "kit-3" } } },
    });
    const res = await reviseBrandKit({ clientId: CLIENT_ID, changes: { tokens: { colors: { accent: "#12b886" } } } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.version).toBe(3);

    const row = fake.inserts.find((i) => i.table === "brand_kits")!.values as Record<string, unknown>;
    expect(row.version).toBe(3);
    expect(row.locked).toBe(true);
    expect(row.tenant_id).toBe("tenant-1");
    expect(row.client_id).toBe(CLIENT_ID);
    // The change was applied through the skill (accent normalized + merged).
    expect((row.tokens as { colors: { accent: string } }).colors.accent).toBe("#12b886");
    // Only ONE brand_kits insert (the old version row is never touched).
    expect(fake.inserts.filter((i) => i.table === "brand_kits")).toHaveLength(1);
  });

  it("carries the prior logo forward when the revision omits it", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      brand_kits: { select: { data: [lockedRow(2)] }, insert: { data: { id: "kit-3" } } },
    });
    const res = await reviseBrandKit({ clientId: CLIENT_ID, changes: { voice_profile: { descriptors: ["warmer"] } } });
    expect(res.ok).toBe(true);
    const row = fake.inserts.find((i) => i.table === "brand_kits")!.values as { assets: { logo_url: string | null } };
    expect(row.assets.logo_url).toBe("https://cdn/logo.svg");
  });

  it("no current kit → no_kit, no insert", async () => {
    const fake = setup({ clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [] } } });
    const res = await reviseBrandKit({ clientId: CLIENT_ID, changes: {} });
    expect(res).toMatchObject({ ok: false, reason: "no_kit" });
    expect(fake.inserts.some((i) => i.table === "brand_kits")).toBe(false);
  });

  it("B1 holds on the revise path: a hostile font change is refused, no write", async () => {
    const fake = setup({ clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [lockedRow(2)] } } });
    const res = await reviseBrandKit({
      clientId: CLIENT_ID,
      changes: { tokens: { typography: { body: 'Inter"; } evil' } } },
    });
    expect(res).toMatchObject({ ok: false, reason: "invalid_brand_input" });
    expect(fake.inserts.some((i) => i.table === "brand_kits")).toBe(false);
  });

  it("B1 scale holds on the revise path: hostile scale key/value/weight refused, no write", async () => {
    const scales = [
      { base: { size: "1rem; } body{display:none} .x{color:red", lineHeight: "1.5rem" } }, // value
      { "x; } body{display:none} .y{": { size: "1rem", lineHeight: "1.5rem" } }, // key
      { base: { size: "1rem", lineHeight: "1.5rem", weight: "700; } body{}" } }, // weight
    ];
    for (const scale of scales) {
      const fake = setup({ clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [lockedRow(2)] } } });
      const res = await reviseBrandKit({
        clientId: CLIENT_ID,
        changes: { tokens: { typography: { scale } } },
      } as unknown as Parameters<typeof reviseBrandKit>[0]);
      expect(res).toMatchObject({ ok: false, reason: "invalid_brand_input" });
      expect(fake.inserts.some((i) => i.table === "brand_kits")).toBe(false);
    }
  });

  it("client_viewer cannot revise: forbidden", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    const res = await reviseBrandKit({ clientId: CLIENT_ID, changes: {} });
    expect(res).toMatchObject({ ok: false, reason: "forbidden" });
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Reads — mirror brand_kits_select (any tenant member)                */
/* ------------------------------------------------------------------ */

describe("read APIs — what M8/M11/theming enforce against", () => {
  it("readLockedBrandKit returns the current locked kit", async () => {
    setup({ brand_kits: { select: { data: [lockedRow(2)] } } });
    const res = await readLockedBrandKit({ clientId: CLIENT_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kit?.version).toBe(2);
    expect(res.kit?.logoUrl).toBe("https://cdn/logo.svg");
    expect(res.kit?.voiceProfile.descriptors).toEqual(["confident"]);
  });

  it("client_viewer CAN read (mirrors brand_kits_select; RLS + client_scope is the boundary)", async () => {
    setup({ brand_kits: { select: { data: [lockedRow(2)] } } }, VIEWER_CLAIMS);
    const res = await readLockedBrandKit({ clientId: CLIENT_ID });
    expect(res.ok).toBe(true);
  });

  it("no locked kit visible → kit: null (foreign/nonexistent == no kit, by RLS design)", async () => {
    setup({ brand_kits: { select: { data: [] } } });
    const res = await readLockedBrandKit({ clientId: CLIENT_ID });
    expect(res).toMatchObject({ ok: true, kit: null });
  });

  it("listBrandKitVersionHistory returns newest-first entries with provenance counts", async () => {
    setup({ brand_kits: { select: { data: [lockedRow(3), lockedRow(2), lockedRow(1)] } } });
    const res = await listBrandKitVersionHistory({ clientId: CLIENT_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries.map((e) => e.version)).toEqual([3, 2, 1]);
    expect(res.entries[0].locked).toBe(true);
  });

  it("a read failure is retryable read_failed, never a lie about 'no kit'", async () => {
    setup({ brand_kits: { select: { error: { message: "boom", code: "PGRST301" } } } });
    const res = await readLockedBrandKit({ clientId: CLIENT_ID });
    expect(res).toMatchObject({ ok: false, reason: "read_failed" });
  });
});

/* ------------------------------------------------------------------ */
/* Redacted telemetry                                                  */
/* ------------------------------------------------------------------ */

describe("redacted failure telemetry (house contract)", () => {
  it("an insert failure logs exactly ONE line: marker + stage + code, no payload", async () => {
    setup({
      clients: { select: { data: CLIENT_ROW } },
      brand_kits: {
        select: { data: [] },
        insert: { error: { message: "secret row data leaked here", code: "PGRST204", details: "Key=(secret@client.com)" } },
      },
    });
    const res = await createBrandKit(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "write_failed" });

    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TELEMETRY);
    expect(lines[0]).toContain("stage=brand_kit_insert");
    expect(lines[0]).toContain("code=PGRST204");
    // No payload / message / details ever ride into the log line.
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).not.toContain("Key=");
  });

  it("an unexpected throw logs the 'thrown' stage with only the code", async () => {
    setup({ clients: { select: { throws: { code: "XX000", message: "secret internal detail" } } } });
    const res = await createBrandKit(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "write_failed" });

    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TELEMETRY);
    expect(lines[0]).toContain("stage=thrown");
    expect(lines[0]).not.toContain("secret");
  });
});
