/**
 * M8 server-action suite (createContentDraft + listContentDrafts + readContentDraft).
 *
 * Only the action's seams are mocked (verified-claims reader, Supabase server
 * client, next/navigation redirect, the deferred content provider → a
 * ScriptedContentProvider); the role guard, uuid clamp, input clamps, the REAL
 * constrain/generate/ground pipeline, the REAL frozen compliance skill, M7's
 * REAL readLockedBrandKit read path, and the real row mapping all run. Pins the
 * review-gated hard properties:
 *  - the draft persists at the PINNED pre-approval state — status 'draft',
 *    automation_level 'ai_draft_human_approve' — structurally never auto-approved;
 *  - claim-sourced tenant on the persisted row (never client-supplied); client_id
 *    from the RLS-scoped clients read; brand_kit_id from M7's RLS-scoped locked kit;
 *  - a hostile payload (forged tenant/status/automation_level/brand_kit_id) is dead weight;
 *  - no locked brand kit → REFUSED (never a silent generic-voice fallback);
 *  - Gate 1a: a dormant vertical → no_playbook; an unsupported type → refused;
 *  - RLS-mirrored auth (operator may write; client_viewer forbidden but may READ);
 *  - redacted telemetry: one line, marker + stage + code, no body/prompt/PII.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { ingestBrandKit } from "@/lib/production/brand-kit";
import { ScriptedContentProvider } from "./provider";
import {
  createContentDraft,
  listContentDrafts,
  readContentDraft,
  type CreateContentDraftInput,
} from "./actions";

/* ------------------------------------------------------------------ */
/* seams                                                               */
/* ------------------------------------------------------------------ */

const { getClaimsMock, createClientMock, providerMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
  providerMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getClaims: getClaimsMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
// The deferred content provider is stubbed to a scriptable fake so the pipeline
// runs with no Anthropic SDK / network (mirrors the audit action mocking ./live-fetch).
vi.mock("./live-provider", () => ({ resolveContentProvider: () => providerMock() }));

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const CLIENT_ID = "4a9f3b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c";
const DRAFT_ID = "1b2c3d4e-5f6a-4b8c-9d0e-1f2a3b4c5d6e";
const OPERATOR_CLAIMS = { tenantId: "tenant-1", role: "operator" as const, sub: "u1" };
const VIEWER_CLAIMS = { tenantId: "tenant-1", role: "client_viewer" as const, clientId: CLIENT_ID, sub: "u3" };

const TELEMETRY = /^\[content-write-failure\] stage=(content_insert|generate|thrown) code=[A-Za-z0-9_]{1,16}$/;

const CLIENT_ROW = { id: CLIENT_ID, vertical: "real-estate" };

/** A complete, well-formed locked `brand_kits` row (id = brand_kit_id 'kit-1'). */
function lockedRow() {
  const res = ingestBrandKit({
    colors: { accent: "#2b6cff" },
    voice: { descriptors: ["confident"], samples: ["We advise, we don’t sell."] },
    logoUrl: "https://cdn/logo.svg",
  });
  if (!res.ok) throw new Error("fixture build failed");
  return {
    id: "kit-1",
    client_id: CLIENT_ID,
    version: 1,
    locked: true,
    tokens: res.kit.tokens,
    voice_profile: res.kit.voice_profile,
    likeness_refs: res.kit.likeness_refs,
    assets: { logo_url: res.logoUrl, ingestion: res.report },
    created_at: "2026-07-09T00:00:00Z",
  };
}

/** The provider used unless a test overrides it — a benign, on-brand real-estate body. */
function benignProvider(body = "A calm, factual overview of the buying process for expat buyers.") {
  return new ScriptedContentProvider().script({ result: { title: "The buying process", body, raw: {} } });
}

function setup(script: FakeScript, claims: unknown = OPERATOR_CLAIMS, provider = benignProvider()) {
  const fake = fakePostgrest(script);
  getClaimsMock.mockResolvedValue(claims);
  createClientMock.mockResolvedValue(fake.client);
  providerMock.mockReturnValue(provider);
  return fake;
}

/** The happy-path script: client read → locked kit → content insert. */
function happyScript(): FakeScript {
  return {
    clients: { select: { data: CLIENT_ROW } },
    brand_kits: { select: { data: [lockedRow()] } },
    content_items: { insert: { data: { id: "ci-1" } } },
  };
}

const VALID_INPUT: CreateContentDraftInput = {
  clientId: CLIENT_ID,
  contentType: "blog",
  topic: "buying property as an expat",
  groundingFacts: ["We advise expat buyers on the local market."],
};

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => call[0] as string);
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  providerMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

/* ------------------------------------------------------------------ */
/* createContentDraft — authz                                          */
/* ------------------------------------------------------------------ */

describe("createContentDraft — authz (mirrors content_items_insert app.is_writer)", () => {
  it("client_viewer: forbidden, no Supabase client + no provider touched", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    const res = await createContentDraft(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "forbidden" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(providerMock).not.toHaveBeenCalled();
  });

  it("operator IS allowed: a draft is generated + persisted", async () => {
    setup(happyScript());
    const res = await createContentDraft(VALID_INPUT);
    expect(res).toMatchObject({ ok: true, contentItemId: "ci-1" });
  });
});

/* ------------------------------------------------------------------ */
/* createContentDraft — the pre-approval structural guarantee          */
/* ------------------------------------------------------------------ */

describe("createContentDraft — structurally never auto-approved", () => {
  it("persists at status='draft', automation_level='ai_draft_human_approve', claim/RLS-sourced scope", async () => {
    const fake = setup(happyScript());
    const res = await createContentDraft(VALID_INPUT);
    expect(res.ok).toBe(true);

    const insert = fake.inserts.find((i) => i.table === "content_items");
    expect(insert).toBeDefined();
    const row = insert!.values as Record<string, unknown>;
    // The two fields that could enable autonomous publishing are PINNED.
    expect(row.status).toBe("draft");
    expect(row.automation_level).toBe("ai_draft_human_approve");
    expect(row.status).not.toBe("approved");
    expect(row.automation_level).not.toBe("auto");
    // Scope is claim/RLS-sourced, never caller-supplied.
    expect(row.tenant_id).toBe("tenant-1");
    expect(row.client_id).toBe(CLIENT_ID);
    expect(row.brand_kit_id).toBe("kit-1");
    expect(row.type).toBe("blog");
    // M8 writes NO review verdict and NO humanization (other owners' columns).
    expect(row).not.toHaveProperty("quality_review");
    expect(row).not.toHaveProperty("compliance_review");
    expect(row).not.toHaveProperty("humanization");
  });

  it("returns a generation report carrying the enforced voice + playbook mapping", async () => {
    setup(happyScript());
    const res = await createContentDraft(VALID_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.voiceEnforced).toContain("confident");
    expect(res.report.playbookMapping.vertical).toBe("real-estate");
    expect(res.report.compliancePrescreen).toHaveProperty("pass");
  });
});

/* ------------------------------------------------------------------ */
/* createContentDraft — hostile payload is dead weight                 */
/* ------------------------------------------------------------------ */

describe("createContentDraft — hostile payload", () => {
  it("ignores forged tenant/status/automation_level/brand_kit_id fields", async () => {
    const fake = setup(happyScript());
    const hostile = {
      ...VALID_INPUT,
      tenant_id: "attacker-tenant",
      status: "approved",
      automation_level: "auto",
      brand_kit_id: "attacker-kit",
      id: "attacker-row",
    } as unknown as CreateContentDraftInput;

    const res = await createContentDraft(hostile);
    expect(res.ok).toBe(true);

    const row = fake.inserts.find((i) => i.table === "content_items")!.values as Record<string, unknown>;
    expect(row.tenant_id).toBe("tenant-1"); // claim, not "attacker-tenant"
    expect(row.status).toBe("draft"); // not "approved"
    expect(row.automation_level).toBe("ai_draft_human_approve"); // not "auto"
    expect(row.brand_kit_id).toBe("kit-1"); // locked kit, not "attacker-kit"
    expect(row).not.toHaveProperty("id"); // db-generated
  });
});

/* ------------------------------------------------------------------ */
/* createContentDraft — refusals                                       */
/* ------------------------------------------------------------------ */

describe("createContentDraft — refusals", () => {
  it("REFUSES a client with no locked brand kit (no generic-voice fallback, no insert)", async () => {
    const fake = setup({
      clients: { select: { data: CLIENT_ROW } },
      brand_kits: { select: { data: [] } }, // no locked kit
    });
    const res = await createContentDraft(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "no_brand_kit" });
    expect(fake.inserts.some((i) => i.table === "content_items")).toBe(false);
    expect(providerMock).not.toHaveBeenCalled();
  });

  it("no_playbook for a dormant vertical (Gate 1a), before reading the kit or generating", async () => {
    const fake = setup({ clients: { select: { data: { id: CLIENT_ID, vertical: "cannabis" } } } });
    const res = await createContentDraft(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "no_playbook" });
    expect(fake.selects.some((s) => s.table === "brand_kits")).toBe(false);
    expect(providerMock).not.toHaveBeenCalled();
  });

  it("unsupported_type for caption / schema_copy (not M8's), no Supabase touched", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    const res = await createContentDraft({ ...VALID_INPUT, contentType: "caption" as never });
    expect(res).toMatchObject({ ok: false, reason: "unsupported_type" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("invalid_input for an empty topic", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    const res = await createContentDraft({ ...VALID_INPUT, topic: "   " });
    expect(res).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("not_found for a non-uuid clientId (junk never reaches Postgres)", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    const res = await createContentDraft({ ...VALID_INPUT, clientId: "not-a-uuid" });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("not_found when the RLS-scoped client read is empty (cross-tenant == nonexistent)", async () => {
    setup({ clients: { select: { data: null } } });
    const res = await createContentDraft(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
  });
});

/* ------------------------------------------------------------------ */
/* createContentDraft — generation unavailable + telemetry redaction   */
/* ------------------------------------------------------------------ */

describe("createContentDraft — deferred/failed generation", () => {
  it("maps a rejecting provider to generation_unavailable + ONE redacted telemetry line", async () => {
    setup(happyScript(), OPERATOR_CLAIMS, new ScriptedContentProvider().failNext(new Error("boom secret prompt")));
    const res = await createContentDraft(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "generation_unavailable" });

    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TELEMETRY);
    // The provider's raw error (which could carry the prompt) never appears.
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).toContain("stage=generate");
  });

  it("write_failed on an insert error logs marker+stage+code ONLY (no message/data leak)", async () => {
    setup({
      clients: { select: { data: CLIENT_ROW } },
      brand_kits: { select: { data: [lockedRow()] } },
      content_items: {
        insert: { error: { code: "23503", message: "insert violates fk; body='secret draft text'" } },
      },
    });
    const res = await createContentDraft(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "write_failed" });

    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TELEMETRY);
    expect(lines[0]).toContain("code=23503");
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).not.toContain("fk");
  });
});

/* ------------------------------------------------------------------ */
/* Reads — the review queue + the single-draft reviewer read           */
/* ------------------------------------------------------------------ */

describe("listContentDrafts / readContentDraft (mirror content_items_select)", () => {
  const summaryRow = {
    id: "ci-1",
    type: "blog",
    status: "draft",
    automation_level: "ai_draft_human_approve",
    brand_kit_id: "kit-1",
    body: "draft body",
    humanization: null,
    quality_review: null,
    compliance_review: null,
    created_at: "2026-07-09T00:00:00Z",
    updated_at: "2026-07-09T00:00:00Z",
  };

  it("client_viewer may LIST drafts (read is open to any tenant member; RLS scopes)", async () => {
    setup({ content_items: { select: { data: [summaryRow] } } }, VIEWER_CLAIMS);
    const res = await listContentDrafts({ clientId: CLIENT_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]).toMatchObject({ id: "ci-1", status: "draft", bodyPreview: "draft body" });
    expect(res.entries[0].pipeline.qualityReviewed).toBe(false);
  });

  it("listContentDrafts: not_found for a bad uuid; read_failed on a read error", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    expect(await listContentDrafts({ clientId: "nope" })).toMatchObject({ ok: false, reason: "not_found" });

    setup({ content_items: { select: { error: { code: "PGRST301", message: "boom" } } } }, VIEWER_CLAIMS);
    expect(await listContentDrafts({ clientId: CLIENT_ID })).toMatchObject({ ok: false, reason: "read_failed" });
  });

  it("readContentDraft: returns full detail, or draft:null for a nonexistent/other-tenant id", async () => {
    setup({ content_items: { select: { data: { ...summaryRow, body: "full body", quality_review: { verdict: "pass" } } } } }, VIEWER_CLAIMS);
    const found = await readContentDraft({ contentItemId: DRAFT_ID });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.draft?.body).toBe("full body");
    expect(found.draft?.pipeline.qualityReviewed).toBe(true);

    setup({ content_items: { select: { data: null } } }, VIEWER_CLAIMS);
    const missing = await readContentDraft({ contentItemId: DRAFT_ID });
    expect(missing).toMatchObject({ ok: true, draft: null });
  });
});
