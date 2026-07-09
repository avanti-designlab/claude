/**
 * M11 server-action suite (createSocialCaption + generateSocialMedia +
 * composeSocialPost + listSocialCaptions + readSocialCaption).
 *
 * Only the action's seams are mocked (verified-claims reader, Supabase server client,
 * next/navigation redirect, the deferred content + media providers → scriptable
 * fakes); the role guard, uuid clamp, input clamps, the REAL caption/media/compose
 * pipeline, the REAL frozen compliance skill, M7's REAL readLockedBrandKit read path,
 * and the real row mapping all run. Pins the review-gated hard properties:
 *  - the caption persists at the PINNED pre-approval state — status 'draft',
 *    automation_level 'ai_draft_human_approve', type 'caption' — never auto-approved;
 *  - claim-sourced tenant; client_id from the RLS-scoped clients read; brand_kit_id
 *    from M7's RLS-scoped locked kit; a hostile forged payload is dead weight;
 *  - no locked brand kit → REFUSED (no generic voice/brand fallback);
 *  - the brand-forced media request carries M7's tokens (palette/logo/likeness);
 *  - compose NEVER posts + nothing is persisted for media/schedule (schema gaps);
 *  - redacted telemetry: one line, marker + stage + code, no body/prompt/PII.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { ingestBrandKit } from "@/lib/production/brand-kit";
import { ScriptedContentProvider } from "@/lib/production/content";
import { ScriptedMediaGenerationProvider } from "./provider";
import {
  composeSocialPost,
  createSocialCaption,
  generateSocialMedia,
  listSocialCaptions,
  readSocialCaption,
  type CreateSocialCaptionInput,
} from "./actions";

/* ------------------------------------------------------------------ */
/* seams                                                               */
/* ------------------------------------------------------------------ */

const { getClaimsMock, createClientMock, contentProviderMock, mediaProviderMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
  contentProviderMock: vi.fn(),
  mediaProviderMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getClaims: getClaimsMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
// The deferred providers are stubbed to scriptable fakes so the pipeline runs with no
// Anthropic / Higgsfield-Motion SDK / network (mirrors the M8 action mocking).
vi.mock("@/lib/production/content/live-provider", () => ({ resolveContentProvider: () => contentProviderMock() }));
vi.mock("./live-provider", () => ({ resolveMediaGenerationProvider: () => mediaProviderMock() }));

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const CLIENT_ID = "4a9f3b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c";
const CAPTION_ID = "1b2c3d4e-5f6a-4b8c-9d0e-1f2a3b4c5d6e";
const OPERATOR_CLAIMS = { tenantId: "tenant-1", role: "operator" as const, sub: "u1" };
const VIEWER_CLAIMS = { tenantId: "tenant-1", role: "client_viewer" as const, clientId: CLIENT_ID, sub: "u3" };

const TELEMETRY = /^\[social-write-failure\] stage=(caption_insert|generate|media|thrown) code=[A-Za-z0-9_]{1,16}$/;

const CLIENT_ROW = { id: CLIENT_ID, vertical: "real-estate" };

/** A complete, well-formed locked `brand_kits` row (id = brand_kit_id 'kit-1'), with likeness refs. */
function lockedRow() {
  const res = ingestBrandKit({
    colors: { accent: "#2b6cff", accentWarm: "#ff7a1a" },
    voice: { descriptors: ["confident"], samples: ["We advise, we don’t sell."], dont: ["cheap"] },
    likeness: { higgsfieldElementIds: ["hf_founder"], motionElementIds: ["mo_product"] },
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

/** The content provider used unless overridden — a benign, on-brand caption body. */
function benignContentProvider(body = "A calm, factual note about the new marina listing.") {
  return new ScriptedContentProvider().script({ result: { title: "cap", body, raw: {} } });
}

function setup(
  script: FakeScript,
  claims: unknown = OPERATOR_CLAIMS,
  content = benignContentProvider(),
  media = new ScriptedMediaGenerationProvider(),
) {
  const fake = fakePostgrest(script);
  getClaimsMock.mockResolvedValue(claims);
  createClientMock.mockResolvedValue(fake.client);
  contentProviderMock.mockReturnValue(content);
  mediaProviderMock.mockReturnValue(media);
  return fake;
}

/** The happy caption path: client read → locked kit → caption insert. */
function happyCaptionScript(): FakeScript {
  return {
    clients: { select: { data: CLIENT_ROW } },
    brand_kits: { select: { data: [lockedRow()] } },
    content_items: { insert: { data: { id: "cap-1" } } },
  };
}

const VALID_CAPTION: CreateSocialCaptionInput = {
  clientId: CLIENT_ID,
  topic: "a new marina listing",
  platform: "instagram",
  groundingFacts: ["The listing is a 2-bed near the marina."],
};

const CAPTION_DETAIL_ROW = {
  id: "cap-1",
  type: "caption",
  status: "draft",
  automation_level: "ai_draft_human_approve",
  brand_kit_id: "kit-1",
  body: "A calm, factual note about the new marina listing.",
  humanization: null,
  quality_review: null,
  compliance_review: null,
  created_at: "2026-07-09T00:00:00Z",
  updated_at: "2026-07-09T00:00:00Z",
};

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => call[0] as string);
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  contentProviderMock.mockReset();
  mediaProviderMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

/* ------------------------------------------------------------------ */
/* createSocialCaption — authz + the pre-approval structural guarantee  */
/* ------------------------------------------------------------------ */

describe("createSocialCaption — authz (mirrors content_items_insert app.is_writer)", () => {
  it("client_viewer: forbidden, no Supabase client + no provider touched", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    const res = await createSocialCaption(VALID_CAPTION);
    expect(res).toMatchObject({ ok: false, reason: "forbidden" });
    expect(createClientMock).not.toHaveBeenCalled();
    expect(contentProviderMock).not.toHaveBeenCalled();
  });

  it("operator IS allowed: a caption is generated + persisted", async () => {
    setup(happyCaptionScript());
    const res = await createSocialCaption(VALID_CAPTION);
    expect(res).toMatchObject({ ok: true, contentItemId: "cap-1" });
  });
});

describe("createSocialCaption — structurally never auto-approved", () => {
  it("persists at type='caption', status='draft', automation_level='ai_draft_human_approve', claim/RLS scope", async () => {
    const fake = setup(happyCaptionScript());
    const res = await createSocialCaption(VALID_CAPTION);
    expect(res.ok).toBe(true);

    const insert = fake.inserts.find((i) => i.table === "content_items");
    expect(insert).toBeDefined();
    const row = insert!.values as Record<string, unknown>;
    expect(row.type).toBe("caption");
    expect(row.status).toBe("draft");
    expect(row.automation_level).toBe("ai_draft_human_approve");
    expect(row.status).not.toBe("approved");
    expect(row.automation_level).not.toBe("auto");
    // scope is claim/RLS-sourced, never caller-supplied
    expect(row.tenant_id).toBe("tenant-1");
    expect(row.client_id).toBe(CLIENT_ID);
    expect(row.brand_kit_id).toBe("kit-1");
    // M11 writes NO review verdict + NO humanization (other owners' columns)
    expect(row).not.toHaveProperty("quality_review");
    expect(row).not.toHaveProperty("compliance_review");
    expect(row).not.toHaveProperty("humanization");
  });

  it("returns a caption report carrying the enforced voice + the 'caption' type + platform", async () => {
    setup(happyCaptionScript());
    const res = await createSocialCaption(VALID_CAPTION);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.report.voiceEnforced).toContain("confident");
    expect(res.report.contentType).toBe("caption");
    expect(res.report.platform).toBe("instagram");
    expect(res.report.compliancePrescreen).toHaveProperty("pass");
  });
});

describe("createSocialCaption — hostile payload is dead weight", () => {
  it("ignores forged tenant/status/automation_level/type/brand_kit_id fields", async () => {
    const fake = setup(happyCaptionScript());
    const hostile = {
      ...VALID_CAPTION,
      tenant_id: "attacker-tenant",
      status: "approved",
      automation_level: "auto",
      type: "blog",
      brand_kit_id: "attacker-kit",
      id: "attacker-row",
    } as unknown as CreateSocialCaptionInput;

    const res = await createSocialCaption(hostile);
    expect(res.ok).toBe(true);

    const row = fake.inserts.find((i) => i.table === "content_items")!.values as Record<string, unknown>;
    expect(row.tenant_id).toBe("tenant-1");
    expect(row.status).toBe("draft");
    expect(row.automation_level).toBe("ai_draft_human_approve");
    expect(row.type).toBe("caption");
    expect(row.brand_kit_id).toBe("kit-1");
    expect(row).not.toHaveProperty("id");
  });
});

describe("createSocialCaption — refusals", () => {
  it("REFUSES a client with no locked brand kit (no generic-brand fallback, no insert, provider untouched)", async () => {
    const fake = setup({ clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [] } } });
    const res = await createSocialCaption(VALID_CAPTION);
    expect(res).toMatchObject({ ok: false, reason: "no_brand_kit" });
    expect(fake.inserts.some((i) => i.table === "content_items")).toBe(false);
    expect(contentProviderMock).not.toHaveBeenCalled();
  });

  it("no_playbook for a dormant vertical (Gate 1a), before reading the kit or generating", async () => {
    const fake = setup({ clients: { select: { data: { id: CLIENT_ID, vertical: "cannabis" } } } });
    const res = await createSocialCaption(VALID_CAPTION);
    expect(res).toMatchObject({ ok: false, reason: "no_playbook" });
    expect(fake.selects.some((s) => s.table === "brand_kits")).toBe(false);
    expect(contentProviderMock).not.toHaveBeenCalled();
  });

  it("invalid_input for an empty topic; not_found for a non-uuid clientId (junk never reaches Postgres)", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    expect(await createSocialCaption({ ...VALID_CAPTION, topic: "   " })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await createSocialCaption({ ...VALID_CAPTION, clientId: "not-a-uuid" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe("createSocialCaption — deferred generation + telemetry redaction", () => {
  it("maps a rejecting content provider to generation_unavailable + ONE redacted telemetry line", async () => {
    setup(happyCaptionScript(), OPERATOR_CLAIMS, new ScriptedContentProvider().failNext(new Error("boom secret prompt")));
    const res = await createSocialCaption(VALID_CAPTION);
    expect(res).toMatchObject({ ok: false, reason: "generation_unavailable" });

    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TELEMETRY);
    expect(lines[0]).toContain("stage=generate");
    expect(lines[0]).not.toContain("secret");
  });

  it("write_failed on an insert error logs marker+stage+code ONLY (no message/data leak)", async () => {
    setup({
      clients: { select: { data: CLIENT_ROW } },
      brand_kits: { select: { data: [lockedRow()] } },
      content_items: { insert: { error: { code: "23503", message: "fk violation; body='secret caption'" } } },
    });
    const res = await createSocialCaption(VALID_CAPTION);
    expect(res).toMatchObject({ ok: false, reason: "write_failed" });

    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("code=23503");
    expect(lines[0]).toContain("stage=caption_insert");
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).not.toContain("fk");
  });
});

/* ------------------------------------------------------------------ */
/* generateSocialMedia — brand-forced + deferred + un-persisted        */
/* ------------------------------------------------------------------ */

describe("generateSocialMedia — brand-forced", () => {
  function mediaScript(): FakeScript {
    return { clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [lockedRow()] } } };
  }

  it("the request carries M7's brand tokens (palette/logo/likeness) as HARD constraints", async () => {
    const media = new ScriptedMediaGenerationProvider().script({
      result: { url: "img://x", type: "image", vendor: "scripted-fake" },
    });
    const fake = setup(mediaScript(), OPERATOR_CLAIMS, benignContentProvider(), media);
    const res = await generateSocialMedia({ clientId: CLIENT_ID, mediaType: "image", prompt: "marina hero, dusk" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // the brand-forced request the provider saw
    expect(media.calls).toHaveLength(1);
    expect(media.calls[0].brand.palette).toContain("#2b6cff");
    expect(media.calls[0].brand.logoUrl).toBe("https://cdn/logo.svg");
    expect(media.calls[0].brand.likenessRefs.higgsfieldElementIds).toContain("hf_founder");
    expect(media.calls[0].brief).toMatchObject({ mediaType: "image", prompt: "marina hero, dusk" });
    // media is NOT persisted (schema gap) — no content_items insert
    expect(fake.inserts.some((i) => i.table === "content_items")).toBe(false);
    expect(res.persistenceNote).toBeTruthy();
  });

  it("REFUSES media with no locked brand kit (brand visual tokens can't be forced)", async () => {
    setup({ clients: { select: { data: CLIENT_ROW } }, brand_kits: { select: { data: [] } } });
    const res = await generateSocialMedia({ clientId: CLIENT_ID, mediaType: "video", prompt: "p" });
    expect(res).toMatchObject({ ok: false, reason: "no_brand_kit" });
  });

  it("a deferred/throwing media provider is honest: media_unavailable + ONE redacted line (stage=media)", async () => {
    setup(mediaScript(), OPERATOR_CLAIMS, benignContentProvider(), new ScriptedMediaGenerationProvider().failNext(new Error("boom secret")));
    const res = await generateSocialMedia({ clientId: CLIENT_ID, mediaType: "image", prompt: "p" });
    expect(res).toMatchObject({ ok: false, reason: "media_unavailable" });
    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("stage=media");
    expect(lines[0]).not.toContain("secret");
  });

  it("invalid_input for a bad media type / empty prompt (never reaches the provider)", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    expect(await generateSocialMedia({ clientId: CLIENT_ID, mediaType: "gif" as never, prompt: "p" })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(await generateSocialMedia({ clientId: CLIENT_ID, mediaType: "image", prompt: "  " })).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* composeSocialPost — PRE-APPROVAL, never posts, never persists        */
/* ------------------------------------------------------------------ */

describe("composeSocialPost — the structural no-auto-post pin", () => {
  it("composes a pinned pre-approval post from a persisted caption; nothing is inserted/posted", async () => {
    const fake = setup({ content_items: { select: { data: CAPTION_DETAIL_ROW } } });
    const res = await composeSocialPost({
      clientId: CLIENT_ID,
      captionContentItemId: CAPTION_ID,
      account: { platform: "instagram", accountRef: "acct-1" },
      when: "2026-08-01T15:00:00Z",
      media: { url: "https://cdn/reel.mp4", type: "video", vendor: "higgsfield" },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.post.status).toBe("composed_pending_human_approval");
    // the caption body came from the PERSISTED caption (not caller-injected text)
    expect(res.post.request.caption).toBe(CAPTION_DETAIL_ROW.body);
    expect(res.post.request.asset).toEqual({ url: "https://cdn/reel.mp4", type: "video" });
    expect(res.post.captionContentItemId).toBe("cap-1");
    // NOT persisted, NOT posted
    expect(fake.inserts).toHaveLength(0);
    expect(res.persistenceNote).toBeTruthy();
  });

  it("reads the caption caption-only + not_found when the id resolves to nothing", async () => {
    const fake = setup({ content_items: { select: { data: null } } });
    const res = await composeSocialPost({
      clientId: CLIENT_ID,
      captionContentItemId: CAPTION_ID,
      account: { platform: "instagram", accountRef: "acct-1" },
      when: "2026-08-01T15:00:00Z",
    });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    // the read narrows to type='caption' (social queue is caption-only)
    const sel = fake.selects.find((s) => s.table === "content_items");
    expect(sel?.filters).toMatchObject({ type: "caption" });
  });

  it("invalid_input for a malformed schedule time / empty account", async () => {
    setup({ content_items: { select: { data: CAPTION_DETAIL_ROW } } });
    expect(
      await composeSocialPost({ clientId: CLIENT_ID, captionContentItemId: CAPTION_ID, account: { platform: "instagram", accountRef: "a" }, when: "not-a-date" }),
    ).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(
      await composeSocialPost({ clientId: CLIENT_ID, captionContentItemId: CAPTION_ID, account: { platform: "", accountRef: "" }, when: "2026-08-01T15:00:00Z" }),
    ).toMatchObject({ ok: false, reason: "invalid_input" });
  });
});

/* ------------------------------------------------------------------ */
/* Reads — the social caption queue + the single-caption reviewer read  */
/* ------------------------------------------------------------------ */

describe("listSocialCaptions / readSocialCaption (mirror content_items_select, type='caption')", () => {
  it("client_viewer may LIST captions; the read narrows to type='caption'", async () => {
    const fake = setup({ content_items: { select: { data: [CAPTION_DETAIL_ROW] } } }, VIEWER_CLAIMS);
    const res = await listSocialCaptions({ clientId: CLIENT_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0]).toMatchObject({ id: "cap-1", type: "caption", status: "draft" });
    const sel = fake.selects.find((s) => s.table === "content_items");
    expect(sel?.filters).toMatchObject({ client_id: CLIENT_ID, type: "caption" });
  });

  it("listSocialCaptions: not_found for a bad uuid; read_failed on a read error", async () => {
    getClaimsMock.mockResolvedValue(VIEWER_CLAIMS);
    expect(await listSocialCaptions({ clientId: "nope" })).toMatchObject({ ok: false, reason: "not_found" });

    setup({ content_items: { select: { error: { code: "PGRST301", message: "boom" } } } }, VIEWER_CLAIMS);
    expect(await listSocialCaptions({ clientId: CLIENT_ID })).toMatchObject({ ok: false, reason: "read_failed" });
  });

  it("readSocialCaption: returns full detail, or caption:null for a nonexistent/other-tenant/non-caption id", async () => {
    setup({ content_items: { select: { data: { ...CAPTION_DETAIL_ROW, quality_review: { verdict: "pass" } } } } }, VIEWER_CLAIMS);
    const found = await readSocialCaption({ contentItemId: CAPTION_ID });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.caption?.body).toBe(CAPTION_DETAIL_ROW.body);
    expect(found.caption?.pipeline.qualityReviewed).toBe(true);

    setup({ content_items: { select: { data: null } } }, VIEWER_CLAIMS);
    expect(await readSocialCaption({ contentItemId: CAPTION_ID })).toMatchObject({ ok: true, caption: null });
  });
});
