/**
 * FakeWebflow — a stateful Data API v2 stand-in for adapter + pipeline tests
 * (no live network; built on the shared ScriptedFetch harness, exactly like
 * FakeWordPress).
 *
 * Faithful where it matters to the safety contract — these are the API
 * semantics the adapter RELIES on, modeled deliberately:
 *  - STAGED vs PUBLISHED: GET/PATCH `/v2/pages/{id}` and
 *    `/v2/collections/{cid}/items/{iid}` read and write the STAGED state
 *    only. The fake snapshots the LIVE (published) state at construction and
 *    never touches it — `livePage()`/`liveItem()` let tests prove a write
 *    changed staging while the live site stayed byte-identical. Publish and
 *    `/live` endpoints are simply not routed (404 `route_not_found`), so any
 *    attempt to publish shows up loudly in the journal AND the response.
 *  - Bearer-token auth (`Authorization: Bearer …`) — wrong/missing → 401
 *    `unauthorized`. `rotateToken()` models a mid-flight rotation/revocation:
 *    the previously-valid token starts failing.
 *  - v2 error envelope `{ message, code }` with slugs like
 *    `resource_not_found`, `too_many_requests`, `validation_error`.
 *  - Page metadata: `seo` + `openGraph` objects with the MIRROR flags
 *    (`titleCopied`/`descriptionCopied`). While a flag is on, the OG value is
 *    DERIVED from the SEO field, and a PATCH to the OG value is ACCEPTED AND
 *    IGNORED (the nastiest real-world shape — no error, echo shows the
 *    mirror). PATCH merges only the provided sub-keys; non-string values fail
 *    400 `validation_error` with no state change.
 *  - Items: `fieldData` partial-merge PATCH; a key the collection's schema
 *    does not declare fails the WHOLE request 400 `validation_error`; the
 *    `slug` field is SERVER-NORMALIZED (lowercased/hyphenated) — the intrinsic
 *    trap the grammar refuses at plan time.
 *  - Rate limiting: `rateLimitNext()` answers 429 `too_many_requests` with a
 *    Retry-After header, state untouched.
 *
 * Fault injection: one-shot any-request or write-only failures with any
 * status/slug, HTML-interstitial mode (a CDN/WAF challenge page where JSON was
 * promised), a write mutator (server-side normalization sim, to force
 * verification failures), entity removal mid-flight, token rotation, and
 * network-level failure via the underlying ScriptedFetch.
 */

import type { Json } from "@/lib/types/db";
import {
  bearerAuthHeader,
  type FetchPort,
  type FetchPortResponse,
} from "../shared/http";
import {
  htmlResponse,
  jsonResponse,
  ScriptedFetch,
  type RecordedRequest,
} from "../shared/http-harness";

export interface FakeWebflowPageSeed {
  /**
   * Owning site id; defaults to the fake's own siteId. Seed a DIFFERENT id to
   * model a mis-routed/cross-site page (the adapter must refuse it pre-write).
   */
  siteId?: string;
  /** Designer-facing page name (NOT the SEO title). */
  name?: string;
  seo?: { title?: string | null; description?: string | null };
  openGraph?: {
    title?: string | null;
    description?: string | null;
    /**
     * The mirror flags. Default models Webflow's reality: a seeded OG value
     * implies the site owner turned the mirror OFF for that field; an unseeded
     * one keeps Webflow's default mirror ON.
     */
    titleCopied?: boolean;
    descriptionCopied?: boolean;
  };
}

export interface FakeWebflowCollectionSeed {
  /** Owning site id; defaults to the fake's siteId (cross-site modeling, as above). */
  siteId?: string;
  /** Declared field slugs (the collection schema). `name` + `slug` are always present. */
  fields?: string[];
  /** itemId → fieldData. */
  items?: Record<string, Record<string, Json>>;
}

export interface FakeWebflowSeed {
  /** Expected raw API token (the Bearer credential). */
  token: string;
  /** The site this fake stands in for (24 lowercase hex chars). */
  siteId: string;
  pages?: Record<string, FakeWebflowPageSeed>;
  collections?: Record<string, FakeWebflowCollectionSeed>;
}

interface StoredPage {
  siteId: string;
  name: string;
  seo: { title: string | null; description: string | null };
  og: {
    title: string | null;
    description: string | null;
    titleCopied: boolean;
    descriptionCopied: boolean;
  };
}

interface StoredCollection {
  siteId: string;
  fields: Set<string>;
  items: Map<string, Record<string, Json>>;
}

const INTERSTITIAL_HTML =
  '<!DOCTYPE html><html lang="en"><head><title>Just a moment...</title></head><body><div id="challenge">Checking your browser before accessing api.webflow.com</div></body></html>';

export class FakeWebflow {
  /** The underlying harness — exposed for network-fault injection + journal. */
  readonly http = new ScriptedFetch();

  private readonly siteId: string;
  private token: string;
  private readonly pages = new Map<string, StoredPage>();
  private readonly collections = new Map<string, StoredCollection>();
  /** The published state, frozen at construction — writes never touch it. */
  private readonly livePages: Map<string, StoredPage>;
  private readonly liveCollections: Map<string, StoredCollection>;
  private htmlInterstitial = false;
  private pendingFailure: FetchPortResponse | null = null;
  private pendingWriteFailure: FetchPortResponse | null = null;
  private writeMutator: ((value: string) => string) | null = null;

  constructor(seed: FakeWebflowSeed) {
    this.token = seed.token;
    this.siteId = seed.siteId;
    for (const [id, p] of Object.entries(seed.pages ?? {})) {
      this.pages.set(id, {
        siteId: p.siteId ?? seed.siteId,
        name: p.name ?? "Untitled page",
        seo: {
          title: p.seo?.title ?? null,
          description: p.seo?.description ?? null,
        },
        og: {
          title: p.openGraph?.title ?? null,
          description: p.openGraph?.description ?? null,
          // Webflow's default is mirror ON; a seeded OG value implies OFF.
          titleCopied:
            p.openGraph?.titleCopied ?? p.openGraph?.title === undefined,
          descriptionCopied:
            p.openGraph?.descriptionCopied ??
            p.openGraph?.description === undefined,
        },
      });
    }
    for (const [id, c] of Object.entries(seed.collections ?? {})) {
      this.collections.set(id, {
        siteId: c.siteId ?? seed.siteId,
        fields: new Set(["name", "slug", ...(c.fields ?? [])]),
        items: new Map(
          Object.entries(c.items ?? {}).map(([iid, fieldData]) => [
            iid,
            { ...fieldData },
          ]),
        ),
      });
    }
    // The publish snapshot: the live site as of the last (pre-test) publish.
    this.livePages = copyPages(this.pages);
    this.liveCollections = copyCollections(this.collections);
    // One catch-all route: like the real API host, every path answers.
    this.http.on("*", /./, (req) => this.handle(req));
  }

  /** The injectable FetchPort for the adapter under test. */
  get port(): FetchPort {
    return this.http.port;
  }

  /** Journal of everything the adapter sent. */
  get requests(): RecordedRequest[] {
    return this.http.requests;
  }

  /* -------- state accessors (byte-exact assertions) -------- */

  /** STAGED page state (effective OG values, mirror applied). */
  page(id: string): {
    seo: { title: string | null; description: string | null };
    openGraph: {
      title: string | null;
      description: string | null;
      titleCopied: boolean;
      descriptionCopied: boolean;
    };
  } {
    return viewPage(this.pages, id);
  }

  /** PUBLISHED page state — must stay untouched by every adapter write. */
  livePage(id: string): ReturnType<FakeWebflow["page"]> {
    return viewPage(this.livePages, id);
  }

  /** STAGED item fieldData. */
  item(collectionId: string, itemId: string): Record<string, Json> {
    return viewItem(this.collections, collectionId, itemId);
  }

  /** PUBLISHED item fieldData — must stay untouched by every adapter write. */
  liveItem(collectionId: string, itemId: string): Record<string, Json> {
    return viewItem(this.liveCollections, collectionId, itemId);
  }

  /* -------- fault injection -------- */

  /** Every request answers 200 + an HTML challenge page (CDN/WAF interstitial). */
  simulateHtmlInterstitial(): this {
    this.htmlInterstitial = true;
    return this;
  }

  /** The NEXT request (any verb) fails once with the given status/slug. */
  failNextWith(status: number, code: string): this {
    this.pendingFailure = envelope(status, code);
    return this;
  }

  /** The next PATCH fails once with the given status/slug (state untouched). */
  failNextWriteWith(status = 500, code = "internal_error"): this {
    this.pendingWriteFailure = envelope(status, code);
    return this;
  }

  /**
   * The NEXT request answers 429 `too_many_requests`, state untouched.
   * `retryAfter` becomes the Retry-After header verbatim (pass garbage to
   * prove the adapter whitelists it); omit for a header-less 429.
   */
  rateLimitNext(retryAfter?: number | string): this {
    this.pendingFailure = jsonResponse(
      429,
      { message: "Too Many Requests", code: "too_many_requests" },
      retryAfter === undefined ? undefined : { "retry-after": String(retryAfter) },
    );
    return this;
  }

  /** Mutate every stored string on write — simulates server-side normalization. */
  mutateWrites(fn: (value: string) => string): this {
    this.writeMutator = fn;
    return this;
  }

  /**
   * Rotate the site's API token: the fake now expects `next`, so a resolver
   * still handing out the old token starts getting 401 `unauthorized` —
   * exactly a mid-flight rotation/revocation.
   */
  rotateToken(next: string): this {
    this.token = next;
    return this;
  }

  /** Remove a page (deleted-behind-our-back scenarios). Staged only. */
  removePage(id: string): this {
    this.pages.delete(id);
    return this;
  }

  /** Remove an item (deleted-behind-our-back scenarios). Staged only. */
  removeItem(collectionId: string, itemId: string): this {
    this.collections.get(collectionId)?.items.delete(itemId);
    return this;
  }

  /* -------- request handling -------- */

  private handle(req: RecordedRequest): FetchPortResponse {
    if (this.htmlInterstitial) return htmlResponse(200, INTERSTITIAL_HTML);
    if (this.pendingFailure) {
      const failure = this.pendingFailure;
      this.pendingFailure = null;
      return failure;
    }
    if (req.headers["authorization"] !== bearerAuthHeader(this.token)) {
      return envelope(401, "unauthorized");
    }

    const path = new URL(req.url).pathname;

    const pageMatch = /^\/v2\/pages\/([0-9a-f]{24})$/.exec(path);
    if (pageMatch) return this.handlePage(req, pageMatch[1]);

    const collectionsMatch = /^\/v2\/sites\/([0-9a-f]{24})\/collections$/.exec(path);
    if (collectionsMatch) return this.handleSiteCollections(collectionsMatch[1]);

    const itemMatch =
      /^\/v2\/collections\/([0-9a-f]{24})\/items\/([0-9a-f]{24})$/.exec(path);
    if (itemMatch) return this.handleItem(req, itemMatch[1], itemMatch[2]);

    // Everything else — INCLUDING publish + /items/{id}/live endpoints, which
    // this fake deliberately does not implement: the adapter must never call
    // them, and if it ever did the failure would be loud, not silent.
    return envelope(404, "route_not_found");
  }

  private handlePage(req: RecordedRequest, id: string): FetchPortResponse {
    const page = this.pages.get(id);
    if (!page) return envelope(404, "resource_not_found");

    if (req.method === "PATCH") {
      if (this.pendingWriteFailure) {
        const failure = this.pendingWriteFailure;
        this.pendingWriteFailure = null;
        return failure;
      }
      const rejected = this.patchPage(page, req.body ?? "{}");
      if (rejected) return rejected;
    }
    return jsonResponse(200, this.renderPage(id, page));
  }

  /** Merge a page-metadata update; a validation failure rejects the WHOLE request. */
  private patchPage(page: StoredPage, bodyText: string): FetchPortResponse | null {
    const body = JSON.parse(bodyText) as { [k: string]: Json };
    const seo = subObject(body.seo);
    const og = subObject(body.openGraph);

    // Validate BEFORE mutating (the real API validates params, then applies).
    for (const group of [seo, og]) {
      for (const key of ["title", "description"] as const) {
        if (group && key in group && typeof group[key] !== "string") {
          return envelope(400, "validation_error");
        }
      }
    }

    const store = (value: string): string =>
      this.writeMutator ? this.writeMutator(value) : value;

    if (seo) {
      if (typeof seo.title === "string") page.seo.title = store(seo.title);
      if (typeof seo.description === "string") {
        page.seo.description = store(seo.description);
      }
    }
    if (og) {
      // THE MIRROR TRAP: while the copied flag is on, the OG value is derived
      // from the SEO field and a write to it is ACCEPTED AND IGNORED — no
      // error, and the echo keeps showing the mirror.
      if (typeof og.title === "string" && !page.og.titleCopied) {
        page.og.title = store(og.title);
      }
      if (typeof og.description === "string" && !page.og.descriptionCopied) {
        page.og.description = store(og.description);
      }
    }
    return null;
  }

  private renderPage(id: string, page: StoredPage): Json {
    return {
      id,
      siteId: page.siteId,
      title: page.name,
      slug: page.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      seo: { title: page.seo.title, description: page.seo.description },
      openGraph: {
        title: page.og.titleCopied ? page.seo.title : page.og.title,
        titleCopied: page.og.titleCopied,
        description: page.og.descriptionCopied
          ? page.seo.description
          : page.og.description,
        descriptionCopied: page.og.descriptionCopied,
      },
      lastUpdated: "2026-07-09T00:00:00.000Z",
    };
  }

  private handleSiteCollections(siteId: string): FetchPortResponse {
    // The fake stands in for ONE site; any other site id is not visible to
    // this token (the real API answers 404 for an inaccessible site).
    if (siteId !== this.siteId) return envelope(404, "resource_not_found");
    const collections = [...this.collections.entries()]
      .filter(([, c]) => c.siteId === siteId)
      .map(([id, c]) => ({
        id,
        displayName: "Collection",
        slug: "collection",
        fields: [...c.fields].map((slug) => ({ slug })),
      }));
    return jsonResponse(200, { collections });
  }

  private handleItem(
    req: RecordedRequest,
    collectionId: string,
    itemId: string,
  ): FetchPortResponse {
    const collection = this.collections.get(collectionId);
    const item = collection?.items.get(itemId);
    if (!collection || !item) return envelope(404, "resource_not_found");

    if (req.method === "PATCH") {
      if (this.pendingWriteFailure) {
        const failure = this.pendingWriteFailure;
        this.pendingWriteFailure = null;
        return failure;
      }
      const rejected = this.patchItem(collection, item, req.body ?? "{}");
      if (rejected) return rejected;
    }
    return jsonResponse(200, this.renderItem(itemId, item));
  }

  /** Merge a fieldData update; a validation failure rejects the WHOLE request. */
  private patchItem(
    collection: StoredCollection,
    item: Record<string, Json>,
    bodyText: string,
  ): FetchPortResponse | null {
    const body = JSON.parse(bodyText) as { [k: string]: Json };
    const fieldData = subObject(body.fieldData);
    if (!fieldData) return null;

    // Validate the whole update BEFORE mutating anything: a fieldData key the
    // collection's schema does not declare fails the request (real v2 behavior
    // — unlike WordPress's silent meta drop, Webflow 400s).
    for (const key of Object.keys(fieldData)) {
      if (!collection.fields.has(key)) return envelope(400, "validation_error");
    }

    for (const [key, value] of Object.entries(fieldData)) {
      if (key === "slug" && typeof value === "string") {
        // INTRINSIC server-side normalization: the stored slug is never
        // guaranteed to be the written slug. (The adapter's grammar refuses
        // slug writes at plan time; this models why.)
        item[key] = normalizeSlug(value);
        continue;
      }
      item[key] =
        this.writeMutator && typeof value === "string"
          ? this.writeMutator(value)
          : value;
    }
    return null;
  }

  private renderItem(id: string, item: Record<string, Json>): Json {
    return {
      id,
      cmsLocaleId: null,
      lastPublished: null,
      lastUpdated: "2026-07-09T00:00:00.000Z",
      createdOn: "2026-01-01T00:00:00.000Z",
      isArchived: false,
      isDraft: false,
      fieldData: { ...item },
    };
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** The v2 error envelope. */
function envelope(status: number, code: string): FetchPortResponse {
  return jsonResponse(status, {
    message: "The request failed. See the code for details.",
    code,
  });
}

/** Webflow's slug normalization (lowercase, non-alphanumerics → hyphens). */
function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function subObject(value: Json | undefined): { [k: string]: Json } | undefined {
  return value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as { [k: string]: Json })
    : undefined;
}

function viewPage(
  pages: Map<string, StoredPage>,
  id: string,
): {
  seo: { title: string | null; description: string | null };
  openGraph: {
    title: string | null;
    description: string | null;
    titleCopied: boolean;
    descriptionCopied: boolean;
  };
} {
  const page = pages.get(id);
  if (!page) throw new Error(`FakeWebflow: no page ${id}`);
  return {
    seo: { ...page.seo },
    openGraph: {
      title: page.og.titleCopied ? page.seo.title : page.og.title,
      description: page.og.descriptionCopied
        ? page.seo.description
        : page.og.description,
      titleCopied: page.og.titleCopied,
      descriptionCopied: page.og.descriptionCopied,
    },
  };
}

function viewItem(
  collections: Map<string, StoredCollection>,
  collectionId: string,
  itemId: string,
): Record<string, Json> {
  const item = collections.get(collectionId)?.items.get(itemId);
  if (!item) throw new Error(`FakeWebflow: no item ${collectionId}/${itemId}`);
  return { ...item };
}

function copyPages(pages: Map<string, StoredPage>): Map<string, StoredPage> {
  return new Map(
    [...pages.entries()].map(([id, p]) => [
      id,
      { ...p, seo: { ...p.seo }, og: { ...p.og } },
    ]),
  );
}

function copyCollections(
  collections: Map<string, StoredCollection>,
): Map<string, StoredCollection> {
  return new Map(
    [...collections.entries()].map(([id, c]) => [
      id,
      {
        siteId: c.siteId,
        fields: new Set(c.fields),
        items: new Map(
          [...c.items.entries()].map(([iid, f]) => [iid, { ...f }]),
        ),
      },
    ]),
  );
}
