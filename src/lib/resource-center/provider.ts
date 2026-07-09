/**
 * M18 Resource Center — the two vendor-deferred PORTS + their scriptable fakes.
 *
 * LOCKED DECISION (doc 04 §7, mirrored from the M8 `ContentGenerationProvider`):
 * modules call these interfaces, NEVER a vendor SDK. The real adapters are the
 * Anthropic API ({@link AnswerProvider}) and a web-search vendor
 * ({@link WebSearchProvider}); both are DEFERRED (BUILD-STATE: ANTHROPIC_API_KEY
 * not yet provisioned — the same blocker that deferred M1b + M8), so they land
 * in ./live-provider behind these ports at wiring time. An Anthropic/vendor SDK
 * import outside its adapter is a Code Review rejection.
 *
 * This module ships ONLY the interfaces + in-memory fakes so the QA engine can
 * be built and tested with ZERO network and NO SDK import (task constraint:
 * port + injected client only). The fakes journal their calls so a test can
 * PROVE the playbook scope + retrieved sources actually reached the provider.
 */

import type {
  AnswerProviderResult,
  AnswerRequest,
  WebSearchRequest,
  WebSearchResult,
} from "./types";

/* ------------------------------------------------------------------ */
/* Ports                                                               */
/* ------------------------------------------------------------------ */

/**
 * The answering LLM (Claude/Anthropic, deferred). Vendor keys live in the
 * secrets vault (doc 04 §5), resolved at call time by the adapter — NEVER
 * constructor-visible on this interface.
 */
export interface AnswerProvider {
  /** Stable vendor id for provenance, e.g. "anthropic", "scripted-fake". */
  readonly vendor: string;
  /** Answer one fully-scoped question, grounded in the request's sources. */
  answer(request: AnswerRequest): Promise<AnswerProviderResult>;
}

/**
 * The web-search retrieval source (deferred). Returns the sources an answer may
 * attribute claims to. An empty array is a legitimate "found nothing" — the
 * engine treats it as an ungrounded answer, never invents a source.
 */
export interface WebSearchProvider {
  readonly vendor: string;
  search(request: WebSearchRequest): Promise<WebSearchResult[]>;
}

/* ------------------------------------------------------------------ */
/* Scriptable answer fake (engine tests; no vendor account/SDK/network) */
/* ------------------------------------------------------------------ */

/**
 * A scripted answer rule: first matching rule wins. `result` may be a function
 * of the request so a test can prove the scope + sources reached the provider
 * (e.g. echo the vertical / a source url into the answer, then assert on it).
 */
export interface AnswerScript {
  /** Substring or regex matched against the question. */
  questionMatch?: string | RegExp;
  result:
    | AnswerProviderResult
    | ((request: AnswerRequest) => AnswerProviderResult);
}

/** Default: an honest, source-attributed answer echoing the first source. */
function defaultAnswer(request: AnswerRequest): AnswerProviderResult {
  const first = request.sources[0];
  return first
    ? {
        answer: `In ${request.scope.vertical}, ${first.snippet}`,
        citedSourceUrls: [first.url],
        answered: true,
        selfConfidence: "medium",
        raw: { source: "scripted-fake", scripted: false },
      }
    : {
        answer: "",
        citedSourceUrls: [],
        answered: false,
        raw: { source: "scripted-fake", scripted: false },
      };
}

/**
 * Scriptable, journaling answer double. Behaves like a vendor adapter with no
 * network or SDK: script responses, then assert on `calls` (the exact requests
 * the engine built — scope + sources all visible). `failNext` exercises the
 * answer_unavailable / thrown paths.
 */
export class ScriptedAnswerProvider implements AnswerProvider {
  readonly vendor = "scripted-fake";
  readonly calls: AnswerRequest[] = [];
  private scripts: AnswerScript[] = [];
  private nextError: Error | null = null;

  script(rule: AnswerScript): this {
    this.scripts.push(rule);
    return this;
  }

  /** The next answer() rejects with `error` (deferred/unavailable/thrown path). */
  failNext(error: Error = new Error("answer provider unavailable")): this {
    this.nextError = error;
    return this;
  }

  async answer(request: AnswerRequest): Promise<AnswerProviderResult> {
    this.calls.push(request);
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    const rule = this.scripts.find(
      (s) =>
        s.questionMatch === undefined ||
        (typeof s.questionMatch === "string"
          ? request.question.includes(s.questionMatch)
          : s.questionMatch.test(request.question)),
    );
    if (!rule) return defaultAnswer(request);
    return typeof rule.result === "function" ? rule.result(request) : rule.result;
  }
}

/* ------------------------------------------------------------------ */
/* Scriptable web-search fake                                          */
/* ------------------------------------------------------------------ */

/** Scripted web-search results, or a per-request function. */
export interface WebSearchScript {
  queryMatch?: string | RegExp;
  results: WebSearchResult[] | ((request: WebSearchRequest) => WebSearchResult[]);
}

/**
 * Scriptable, journaling web-search double. Script results, then assert on
 * `calls`. `failNext` exercises the web-search-unavailable path (retrieval
 * empty by force → the engine reports `webSearchAvailable: false`).
 */
export class ScriptedWebSearchProvider implements WebSearchProvider {
  readonly vendor = "scripted-fake";
  readonly calls: WebSearchRequest[] = [];
  private scripts: WebSearchScript[] = [];
  private nextError: Error | null = null;

  script(rule: WebSearchScript): this {
    this.scripts.push(rule);
    return this;
  }

  failNext(error: Error = new Error("web search unavailable")): this {
    this.nextError = error;
    return this;
  }

  async search(request: WebSearchRequest): Promise<WebSearchResult[]> {
    this.calls.push(request);
    if (this.nextError) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    const rule = this.scripts.find(
      (s) =>
        s.queryMatch === undefined ||
        (typeof s.queryMatch === "string"
          ? request.query.includes(s.queryMatch)
          : s.queryMatch.test(request.query)),
    );
    if (!rule) return [];
    const out = typeof rule.results === "function" ? rule.results(request) : rule.results;
    return out.slice(0, request.maxResults);
  }
}
