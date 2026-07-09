/**
 * FakeWix — a stateful Wix REST stand-in for adapter + pipeline tests
 * (no live network; built on the shared ScriptedFetch harness, exactly like
 * FakeWordPress / FakeWebflow).
 *
 * Faithful where it matters to the safety contract — these are the API
 * semantics the adapter RELIES on, modeled deliberately:
 *  - LIVE-IMMEDIATE: there is deliberately NO staged/published split and no
 *    livePage()/liveItem() accessor pair — on Wix a write to page SEO or a
 *    Data item IS the live site the moment the API accepts it. The absence of
 *    a publish layer is the semantic doc 04 must be honest about for this
 *    method (the exact opposite of FakeWebflow's staged model).
 *  - API-key auth: the Authorization header carries the key BARE (Wix API
 *    keys use no Basic/Bearer scheme — a `Bearer `-prefixed key fails 401,
 *    which traps an adapter that borrows another vendor's header shape), and
 *    EVERY request must carry `wix-site-id` equal to this fake's site: API
 *    keys are account-level, so the header is what scopes a call to one site.
 *    A missing or foreign site id answers 404 SITE_NOT_FOUND — this fake
 *    stands in for ONE site, and nothing else is visible through it.
 *    `rotateKey()` models a mid-flight rotation/revocation.
 *  - Error envelope `{ message, details: { applicationError: { code } } }`
 *    with slugs like ITEM_NOT_FOUND, INVALID_ARGUMENT, RATE_LIMIT_EXCEEDED —
 *    the NESTED code path the adapter's sanitizer must reach.
 *  - Pages: GET/PATCH `/site-pages/v1/pages/{id}` with an `seoData` object
 *    whose UNSET keys are OMITTED from the payload (an unset field inherits
 *    the site-level SEO pattern — the derived-value state the adapter must
 *    refuse). PATCH merges only the provided seoData keys; non-string values
 *    fail 400 INVALID_ARGUMENT with no state change.
 *  - Data items: GET `/wix-data/v2/items/{id}?dataCollectionId=...`, and
 *    Update Data Item as PUT `/wix-data/v2/items/{id}` — a FULL REPLACE:
 *    user fields become exactly the body's non-system keys (an omitted
 *    sibling is DELETED — the trap that forces the adapter's read-fresh →
 *    swap-one-field → write-back discipline). System fields (`_id`,
 *    `_createdDate`, `_updatedDate`, `_owner`) are server-managed: ignored if
 *    sent, always echoed, and `_updatedDate` ADVANCES on every write — the
 *    adapter's verification must target user fields only.
 *  - Rate limiting: `rateLimitNext()` answers 429 with a Retry-After header,
 *    state untouched.
 *
 * Fault injection: one-shot any-request or write-only failures with any
 * status/slug, HTML-interstitial mode (a CDN/WAF challenge page where JSON
 * was promised), a write mutator (server-side normalization sim, to force
 * verification failures), entity removal mid-flight, key rotation,
 * network-level failure via the underlying ScriptedFetch — plus the
 * concurrent-editor pair (mirroring FakeWebflow's setMirror /
 * flipMirrorOnNextPatch split): `editDataItem()` models a client-staff CMS
 * edit landing BETWEEN our calls (the adapter's next fresh read picks it up
 * and re-carries it), and `editDataItemOnNextPut()` lands the edit at the
 * exact instant the next PUT to that item arrives — AFTER the adapter's
 * fresh pre-write GET, BEFORE the full replace processes — the GET→PUT
 * window of the gate-dispositioned ACCEPTED RESIDUAL (adapter header). And
 * `simulateSeoDataReplaceSemantics()` flips the pages PATCH from merge to
 * replace semantics (non-provided seoData keys are WIPED), the canary
 * counterfactual the adapter's non-target verification must catch.
 */

import type { Json } from "@/lib/types/db";
import type { FetchPort, FetchPortResponse } from "../shared/http";
import {
  htmlResponse,
  jsonResponse,
  ScriptedFetch,
  type RecordedRequest,
} from "../shared/http-harness";

export interface FakeWixPageSeed {
  /** Editor-facing page name (NOT the SEO title). */
  name?: string;
  /**
   * Explicitly-set SEO fields. An OMITTED key models Wix's unset state — the
   * page inherits the site-level SEO pattern, and the rendered payload simply
   * has no such key (the derived-value state the adapter refuses).
   */
  seoData?: { title?: string; description?: string };
}

export interface FakeWixCollectionSeed {
  /** itemId → user fields (system fields are added by the fake). */
  items?: Record<string, Record<string, Json>>;
}

export interface FakeWixSeed {
  /** Expected raw API key (sent bare in the Authorization header). */
  apiKey: string;
  /** The site this fake stands in for (a metaSiteId GUID). */
  siteId: string;
  pages?: Record<string, FakeWixPageSeed>;
  collections?: Record<string, FakeWixCollectionSeed>;
}

interface StoredPage {
  name: string;
  seoData: { title?: string; description?: string };
}

interface StoredItem {
  user: Record<string, Json>;
  system: {
    _createdDate: string;
    _updatedDate: string;
    _owner: string;
  };
}

const INTERSTITIAL_HTML =
  '<!DOCTYPE html><html lang="en"><head><title>Just a moment...</title></head><body><div id="challenge">Checking your browser before accessing www.wixapis.com</div></body></html>';

const EPOCH_MS = Date.UTC(2026, 6, 9, 0, 0, 0);

export class FakeWix {
  /** The underlying harness — exposed for network-fault injection + journal. */
  readonly http = new ScriptedFetch();

  private readonly siteId: string;
  private apiKey: string;
  private readonly pages = new Map<string, StoredPage>();
  private readonly collections = new Map<string, Map<string, StoredItem>>();
  private htmlInterstitial = false;
  private pendingFailure: FetchPortResponse | null = null;
  private pendingWriteFailure: FetchPortResponse | null = null;
  private writeMutator: ((value: string) => string) | null = null;
  private pendingItemEdit: {
    collectionId: string;
    itemId: string;
    fields: Record<string, Json>;
  } | null = null;
  private seoDataReplaceSemantics = false;
  /** Deterministic `_updatedDate` advancement — one tick per accepted write. */
  private writeSeq = 0;

  constructor(seed: FakeWixSeed) {
    this.apiKey = seed.apiKey;
    this.siteId = seed.siteId;
    for (const [id, p] of Object.entries(seed.pages ?? {})) {
      this.pages.set(id, {
        name: p.name ?? "Untitled page",
        seoData: { ...(p.seoData ?? {}) },
      });
    }
    for (const [cid, c] of Object.entries(seed.collections ?? {})) {
      const items = new Map<string, StoredItem>();
      for (const [iid, user] of Object.entries(c.items ?? {})) {
        items.set(iid, {
          user: { ...user },
          system: {
            _createdDate: new Date(EPOCH_MS - 86_400_000).toISOString(),
            _updatedDate: new Date(EPOCH_MS).toISOString(),
            _owner: "owner-account",
          },
        });
      }
      this.collections.set(cid, items);
    }
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

  /** LIVE page state — every accepted write IS the live site on Wix. */
  page(id: string): {
    name: string;
    seoData: { title?: string; description?: string };
  } {
    const page = this.pages.get(id);
    if (!page) throw new Error(`FakeWix: no page ${id}`);
    return { name: page.name, seoData: { ...page.seoData } };
  }

  /** LIVE item user fields (system fields via {@link itemSystem}). */
  item(collectionId: string, itemId: string): Record<string, Json> {
    return { ...this.storedItem(collectionId, itemId).user };
  }

  /** The item's server-managed system fields (`_updatedDate` advances on writes). */
  itemSystem(
    collectionId: string,
    itemId: string,
  ): { _createdDate: string; _updatedDate: string; _owner: string } {
    return { ...this.storedItem(collectionId, itemId).system };
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

  /** The next write (PATCH/PUT) fails once with the given status/slug (state untouched). */
  failNextWriteWith(status = 500, code = "INTERNAL_ERROR"): this {
    this.pendingWriteFailure = envelope(status, code);
    return this;
  }

  /**
   * The NEXT request answers 429 RATE_LIMIT_EXCEEDED, state untouched.
   * `retryAfter` becomes the Retry-After header verbatim (pass garbage to
   * prove the adapter whitelists it); omit for a header-less 429.
   */
  rateLimitNext(retryAfter?: number | string): this {
    this.pendingFailure = jsonResponse(
      429,
      wixError("RATE_LIMIT_EXCEEDED"),
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
   * A client-staff CMS edit landing AT REST (between our API calls): the
   * given user fields merge into the item immediately and `_updatedDate`
   * advances, exactly as if someone saved the item in the CMS editor. An
   * adapter write that starts AFTER this edit picks it up on its fresh
   * pre-write GET and re-carries it intact — the boundary case OUTSIDE the
   * accepted-residual window (see {@link editDataItemOnNextPut}).
   */
  editDataItem(
    collectionId: string,
    itemId: string,
    fields: Record<string, Json>,
  ): this {
    const item = this.storedItem(collectionId, itemId);
    item.user = { ...item.user, ...fields };
    this.writeSeq++;
    item.system._updatedDate = new Date(
      EPOCH_MS + this.writeSeq * 1000,
    ).toISOString();
    return this;
  }

  /**
   * One-shot MID-WRITE edit (mirrors FakeWebflow.flipMirrorOnNextPatch): the
   * given user fields land on the item at the instant the NEXT PUT to it
   * arrives — i.e. AFTER the adapter's fresh pre-write GET (whose payload did
   * not include them) and BEFORE the full-replace processes. This is the
   * GET→PUT concurrent-edit window the 2026-07-09 gates dispositioned as an
   * ACCEPTED RESIDUAL: Wix Data v2's update is last-writer-wins with no
   * conditional/partial variant, so the PUT overwrites the edit with the
   * re-carried pre-edit values and echoes exactly what the adapter sent —
   * no verification can see it, and the write reports clean success.
   */
  editDataItemOnNextPut(
    collectionId: string,
    itemId: string,
    fields: Record<string, Json>,
  ): this {
    this.pendingItemEdit = { collectionId, itemId, fields };
    return this;
  }

  /**
   * Flip the pages PATCH from MERGE to REPLACE semantics: the seoData object
   * becomes exactly the provided keys, so a single-key PATCH WIPES the other
   * attribute. The adapter assumes merge semantics (its header's
   * first-live-write canary); this toggle is the counterfactual that proves
   * the non-target echo verification turns silent live data loss into a loud
   * write_verification_failed.
   */
  simulateSeoDataReplaceSemantics(): this {
    this.seoDataReplaceSemantics = true;
    return this;
  }

  /**
   * Rotate the account's API key: the fake now expects `next`, so a resolver
   * still handing out the old key starts getting 401 UNAUTHENTICATED —
   * exactly a mid-flight rotation/revocation.
   */
  rotateKey(next: string): this {
    this.apiKey = next;
    return this;
  }

  /** Remove a page (deleted-behind-our-back scenarios). */
  removePage(id: string): this {
    this.pages.delete(id);
    return this;
  }

  /** Remove an item (deleted-behind-our-back scenarios). */
  removeItem(collectionId: string, itemId: string): this {
    this.collections.get(collectionId)?.delete(itemId);
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
    if (req.headers["authorization"] !== this.apiKey) {
      // Bare-key auth: a wrong, missing, or scheme-prefixed ("Bearer ...")
      // Authorization header is refused — Wix API keys carry no scheme.
      return envelope(401, "UNAUTHENTICATED");
    }
    if (req.headers["wix-site-id"] !== this.siteId) {
      // The account key is site-scoped by this header; this fake stands in
      // for ONE site, and any other (or missing) site id is not visible to it.
      return envelope(404, "SITE_NOT_FOUND");
    }

    const url = new URL(req.url);
    const path = url.pathname;

    const pageMatch = /^\/site-pages\/v1\/pages\/([A-Za-z0-9_-]+)$/.exec(path);
    if (pageMatch) return this.handlePage(req, pageMatch[1]);

    const itemMatch = /^\/wix-data\/v2\/items\/([A-Za-z0-9_-]+)$/.exec(path);
    if (itemMatch) return this.handleItem(req, url, itemMatch[1]);

    // Everything else — there are no publish/staging endpoints to model: a
    // Wix write is live on acceptance. Unknown routes fail loudly.
    return envelope(404, "ROUTE_NOT_FOUND");
  }

  private handlePage(req: RecordedRequest, id: string): FetchPortResponse {
    const page = this.pages.get(id);
    if (!page) return envelope(404, "PAGE_NOT_FOUND");

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

  /** Merge a seoData update; a validation failure rejects the WHOLE request. */
  private patchPage(page: StoredPage, bodyText: string): FetchPortResponse | null {
    const body = JSON.parse(bodyText) as { [k: string]: Json };
    const pageBody = subObject(body.page);
    const seoData = pageBody ? subObject(pageBody.seoData) : undefined;
    if (!seoData) return null;

    // Validate BEFORE mutating (the real API validates params, then applies).
    for (const key of ["title", "description"] as const) {
      if (key in seoData && typeof seoData[key] !== "string") {
        return envelope(400, "INVALID_ARGUMENT");
      }
    }

    if (this.seoDataReplaceSemantics) {
      // REPLACE semantics (the canary counterfactual): seoData becomes
      // exactly the provided keys — a non-provided attribute is WIPED back
      // to unset, silently, before the provided keys are stored below.
      page.seoData = {};
    }

    const store = (value: string): string =>
      this.writeMutator ? this.writeMutator(value) : value;
    if (typeof seoData.title === "string") {
      page.seoData.title = store(seoData.title);
    }
    if (typeof seoData.description === "string") {
      page.seoData.description = store(seoData.description);
    }
    this.writeSeq++;
    return null;
  }

  private renderPage(id: string, page: StoredPage): Json {
    // UNSET keys are OMITTED — the payload carries only explicitly-set fields
    // (an omitted field inherits the site-level SEO pattern).
    const seoData: { [k: string]: Json } = {};
    if (page.seoData.title !== undefined) seoData.title = page.seoData.title;
    if (page.seoData.description !== undefined) {
      seoData.description = page.seoData.description;
    }
    return { page: { id, name: page.name, seoData } };
  }

  private handleItem(
    req: RecordedRequest,
    url: URL,
    itemId: string,
  ): FetchPortResponse {
    if (req.method === "GET") {
      const collectionId = url.searchParams.get("dataCollectionId");
      if (!collectionId) return envelope(400, "INVALID_ARGUMENT");
      return this.renderItemResponse(collectionId, itemId);
    }

    if (req.method === "PUT") {
      const body = JSON.parse(req.body ?? "{}") as { [k: string]: Json };
      const collectionId =
        typeof body.dataCollectionId === "string" ? body.dataCollectionId : null;
      if (!collectionId) return envelope(400, "INVALID_ARGUMENT");
      const dataItem = subObject(body.dataItem);
      const data = dataItem ? subObject(dataItem.data) : undefined;
      if (!data) return envelope(400, "INVALID_ARGUMENT");

      const item = this.collections.get(collectionId)?.get(itemId);
      if (!item) return envelope(404, "ITEM_NOT_FOUND");

      if (
        this.pendingItemEdit &&
        this.pendingItemEdit.collectionId === collectionId &&
        this.pendingItemEdit.itemId === itemId
      ) {
        // The one-shot concurrent edit lands NOW — the PUT has arrived (the
        // adapter's fresh GET is behind us) but has not yet processed. It is
        // another actor's write, so it lands regardless of what happens to
        // OUR request next; the full replace below then overwrites it.
        const edit = this.pendingItemEdit;
        this.pendingItemEdit = null;
        item.user = { ...item.user, ...edit.fields };
        this.writeSeq++;
        item.system._updatedDate = new Date(
          EPOCH_MS + this.writeSeq * 1000,
        ).toISOString();
      }

      if (this.pendingWriteFailure) {
        const failure = this.pendingWriteFailure;
        this.pendingWriteFailure = null;
        return failure;
      }

      // FULL REPLACE: user fields become exactly the body's non-system keys —
      // an omitted sibling is gone. System fields in the body are IGNORED
      // (server-managed); `_updatedDate` advances on every accepted write.
      const next: Record<string, Json> = {};
      for (const [key, value] of Object.entries(data)) {
        if (key.startsWith("_")) continue;
        next[key] =
          this.writeMutator && typeof value === "string"
            ? this.writeMutator(value)
            : value;
      }
      item.user = next;
      this.writeSeq++;
      item.system._updatedDate = new Date(
        EPOCH_MS + this.writeSeq * 1000,
      ).toISOString();
      return this.renderItemResponse(collectionId, itemId);
    }

    return envelope(404, "ROUTE_NOT_FOUND");
  }

  private renderItemResponse(
    collectionId: string,
    itemId: string,
  ): FetchPortResponse {
    const item = this.collections.get(collectionId)?.get(itemId);
    if (!item) return envelope(404, "ITEM_NOT_FOUND");
    return jsonResponse(200, {
      dataItem: {
        id: itemId,
        dataCollectionId: collectionId,
        data: { _id: itemId, ...item.system, ...item.user },
      },
    });
  }

  private storedItem(collectionId: string, itemId: string): StoredItem {
    const item = this.collections.get(collectionId)?.get(itemId);
    if (!item) throw new Error(`FakeWix: no item ${collectionId}/${itemId}`);
    return item;
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** The Wix error body: free-text message + NESTED applicationError code. */
function wixError(code: string): Json {
  return {
    message: "The request failed. See the application error for details.",
    details: { applicationError: { code, description: "See documentation." } },
  };
}

function envelope(status: number, code: string): FetchPortResponse {
  return jsonResponse(status, wixError(code));
}

function subObject(value: Json | undefined): { [k: string]: Json } | undefined {
  return value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value)
    ? (value as { [k: string]: Json })
    : undefined;
}
