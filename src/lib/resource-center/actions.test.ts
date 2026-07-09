/**
 * M18 server-action suite (askResourceQuestion).
 *
 * Only the action's seams are mocked (verified-claims reader, Supabase server
 * client, next/navigation redirect, the two deferred providers → scriptable
 * fakes); the auth guard, uuid clamp, question clamp, the REAL scope/answer/
 * ground engine, the REAL feed shaping, and the REAL no-op persistence all run.
 * Pins:
 *  - READ-LIKE AUTHZ: any authenticated tenant member may ask (doc 05 M18 —
 *    clients query the assistant too); RLS scopes the client-vertical read.
 *  - CLAIM/RLS-SOURCED SCOPE: a cross-tenant/nonexistent clientId is not_found
 *    (doc 03 §4); the vertical comes from the RLS read, never the caller.
 *  - PERSISTENCE SECURITY: nothing is written (no frozen-schema home), the gap
 *    flag is surfaced — a hostile payload cannot force a persisted row.
 *  - HONESTY: a deferred/throwing answer provider → answer_unavailable with ONE
 *    redacted telemetry line (marker + stage + code, no question/answer/secret).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakePostgrest, type FakeScript } from "@/lib/plans/postgrest-fake";
import { ScriptedAnswerProvider, ScriptedWebSearchProvider } from "./provider";
import { askResourceQuestion, type AskResourceQuestionInput } from "./actions";

/* seams */
const { getClaimsMock, createClientMock, answerMock, webMock } = vi.hoisted(() => ({
  getClaimsMock: vi.fn(),
  createClientMock: vi.fn(),
  answerMock: vi.fn(),
  webMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  redirect: (path: string): never => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ getClaims: getClaimsMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));
vi.mock("./live-provider", () => ({
  resolveAnswerProvider: () => answerMock(),
  resolveWebSearchProvider: () => webMock(),
}));

/* fixtures */
const CLIENT_ID = "4a9f3b5c-6d7e-4f8a-9b0c-1d2e3f4a5b6c";
const OPERATOR_CLAIMS = { tenantId: "tenant-1", role: "operator" as const, sub: "u1" };
const VIEWER_CLAIMS = { tenantId: "tenant-1", role: "client_viewer" as const, clientId: CLIENT_ID, sub: "u3" };
const CLIENT_ROW = { id: CLIENT_ID, vertical: "real-estate" };

const TELEMETRY = /^\[resource-center-failure\] stage=(lookup|answer|web_search|thrown) code=[A-Za-z0-9_]{1,16}$/;

const VALID_INPUT: AskResourceQuestionInput = { clientId: CLIENT_ID, question: "what is escrow?" };

/** A grounded answer fake: web returns a source, the LLM cites it. */
function groundedAnswer() {
  return new ScriptedAnswerProvider().script({
    result: (r) => ({
      answer: `In ${r.scope.vertical}: ${r.sources[0]?.snippet ?? ""}`,
      citedSourceUrls: r.sources.map((s) => s.url),
      answered: true,
      selfConfidence: "high",
      raw: {},
    }),
  });
}
function webWithSource() {
  return new ScriptedWebSearchProvider().script({
    results: [{ title: "NAR", url: "https://nar.realtor/g", snippet: "Escrow holds funds." }],
  });
}

function setup(
  script: FakeScript,
  claims: unknown = OPERATOR_CLAIMS,
  answer = groundedAnswer(),
  web = webWithSource(),
) {
  const fake = fakePostgrest(script);
  getClaimsMock.mockResolvedValue(claims);
  createClientMock.mockResolvedValue(fake.client);
  answerMock.mockReturnValue(answer);
  webMock.mockReturnValue(web);
  return fake;
}

const happyScript: FakeScript = { clients: { select: { data: CLIENT_ROW } } };

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
function loggedLines(): string[] {
  return consoleErrorSpy.mock.calls.map((call: unknown[]) => call[0] as string);
}

beforeEach(() => {
  getClaimsMock.mockReset();
  createClientMock.mockReset();
  answerMock.mockReset();
  webMock.mockReset();
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleErrorSpy.mockRestore());

/* ------------------------------------------------------------------ */

describe("askResourceQuestion — authz (read-like: operators AND clients query)", () => {
  it("client_viewer MAY ask (doc 05 M18); RLS scopes the client-vertical read", async () => {
    setup(happyScript, VIEWER_CLAIMS);
    const res = await askResourceQuestion(VALID_INPUT);
    expect(res.ok).toBe(true);
  });

  it("operator MAY ask", async () => {
    setup(happyScript, OPERATOR_CLAIMS);
    const res = await askResourceQuestion(VALID_INPUT);
    expect(res.ok).toBe(true);
  });

  it("unauthenticated → redirect propagates (getClaims null)", async () => {
    getClaimsMock.mockResolvedValue(null);
    await expect(askResourceQuestion(VALID_INPUT)).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

describe("askResourceQuestion — grounded happy path + feeds", () => {
  it("returns a grounded, high-confidence answer + the M3/M8 feed shapes + Content-Quality gate", async () => {
    setup(happyScript);
    const res = await askResourceQuestion(VALID_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.payload.answer.grounded).toBe(true);
    expect(res.payload.answer.confidence).toBe("high");
    expect(res.payload.answer.sources).toHaveLength(1);
    expect(res.payload.scope.vertical).toBe("real-estate");
    expect(res.payload.reviewGate).toBe("content-quality");

    // Feeds are shaped for the consumers.
    expect(res.payload.feeds.promptVolume).toMatchObject({ vertical: "real-estate", source: "resource_center" });
    expect(res.payload.feeds.contentResearch.topic).toBe("what is escrow?");
    expect(res.payload.feeds.contentResearch.groundingFacts).toEqual(["Escrow holds funds."]);
  });
});

describe("askResourceQuestion — persistence security (nothing is written)", () => {
  it("persists no row + surfaces the gap flag, even with a hostile payload", async () => {
    const fake = setup(happyScript);
    const hostile = {
      ...VALID_INPUT,
      tenant_id: "attacker-tenant",
      table: "content_items",
      id: "attacker-row",
    } as unknown as AskResourceQuestionInput;

    const res = await askResourceQuestion(hostile);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No table is written — the exchange is not persisted.
    expect(fake.inserts).toHaveLength(0);
    expect(res.payload.persistence.persisted).toBe(false);
    expect(res.payload.persistence.flag).toMatch(/NOT persisted|not persisted/);
  });
});

describe("askResourceQuestion — refusals", () => {
  it("not_found for a non-uuid clientId (junk never reaches Postgres)", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    const res = await askResourceQuestion({ ...VALID_INPUT, clientId: "not-a-uuid" });
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("invalid_input for an empty question (nothing asked, no Supabase touched)", async () => {
    getClaimsMock.mockResolvedValue(OPERATOR_CLAIMS);
    const res = await askResourceQuestion({ ...VALID_INPUT, question: "   " });
    expect(res).toMatchObject({ ok: false, reason: "invalid_input" });
    expect(createClientMock).not.toHaveBeenCalled();
  });

  it("not_found when the RLS-scoped client read is empty (cross-tenant == nonexistent)", async () => {
    setup({ clients: { select: { data: null } } });
    const res = await askResourceQuestion(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "not_found" });
    expect(answerMock).not.toHaveBeenCalled();
  });

  it("no_playbook for a dormant vertical (Gate 1a), before any provider is touched", async () => {
    setup({ clients: { select: { data: { id: CLIENT_ID, vertical: "cannabis" } } } });
    const res = await askResourceQuestion(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "no_playbook" });
    expect(answerMock).not.toHaveBeenCalled();
  });

  it("lookup_failed on a client read error logs marker+stage+code ONLY (no leak)", async () => {
    setup({ clients: { select: { error: { code: "PGRST301", message: "boom vertical='secret'" } } } });
    const res = await askResourceQuestion(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "lookup_failed" });
    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TELEMETRY);
    expect(lines[0]).toContain("code=PGRST301");
    expect(lines[0]).not.toContain("secret");
  });
});

describe("askResourceQuestion — deferred/unavailable answering + telemetry redaction", () => {
  it("a rejecting answer provider → answer_unavailable + ONE redacted telemetry line", async () => {
    setup(happyScript, OPERATOR_CLAIMS, new ScriptedAnswerProvider().failNext(new Error("boom secret prompt")));
    const res = await askResourceQuestion(VALID_INPUT);
    expect(res).toMatchObject({ ok: false, reason: "answer_unavailable" });

    const lines = loggedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(TELEMETRY);
    expect(lines[0]).toContain("stage=answer");
    // The provider's raw error (which could carry the prompt) never appears.
    expect(lines[0]).not.toContain("secret");
  });
});

describe("askResourceQuestion — honesty warnings", () => {
  it("warns (not fails) when the answer isn't grounded — web search unavailable", async () => {
    const ans = new ScriptedAnswerProvider().script({
      result: { answer: "playbook-only", citedSourceUrls: [], answered: true, selfConfidence: "high", raw: {} },
    });
    setup(happyScript, OPERATOR_CLAIMS, ans, new ScriptedWebSearchProvider()); // web returns []
    webMock.mockReturnValue(null); // no web-search provider at all
    const res = await askResourceQuestion(VALID_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.answer.grounded).toBe(false);
    expect(res.payload.answer.confidence).toBe("low");
    expect(res.warning).toMatch(/verify|low-confidence/i);
  });

  it("warns when the assistant honestly found no answer", async () => {
    const ans = new ScriptedAnswerProvider().script({
      result: { answer: "", citedSourceUrls: [], answered: false, raw: {} },
    });
    setup(happyScript, OPERATOR_CLAIMS, ans);
    const res = await askResourceQuestion(VALID_INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.payload.answer.answered).toBe(false);
    expect(res.warning).toMatch(/no grounded answer|open research/i);
  });
});
