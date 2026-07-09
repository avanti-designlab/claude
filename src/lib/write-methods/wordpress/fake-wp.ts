/**
 * FakeWordPress — a stateful wp/v2 stand-in for adapter + pipeline tests
 * (no live network; built on the shared ScriptedFetch harness, the same way
 * the Webflow/Wix fakes will be).
 *
 * Faithful where it matters to the safety contract:
 *  - GET/POST `{base}/wp-json/wp/v2/{posts|pages|media}/{id}` with raw fields
 *    under `context=edit` (title/content as `{raw, rendered}`, meta object,
 *    media alt_text) — POST merges the update and echoes the stored entity,
 *    exactly the surface the adapter's byte-exact verification reads.
 *  - Basic-auth check against the expected Application Password pair
 *    (wrong/missing → 401 `incorrect_password`).
 *  - Unknown entity → 404 `rest_post_invalid_id`; unknown route → 404
 *    `rest_no_route`.
 *  - Registered-meta fidelity (opt-in via `registeredMeta`): only registered
 *    keys are rendered, ZERO registered keys renders `meta: []` (the PHP
 *    empty-array quirk), writes to unregistered keys are silently ignored,
 *    and a registered-type mismatch fails 400 `rest_invalid_param`.
 *
 * Fault injection: login-redirect HTML mode (the classic), one-shot write
 * failures with any status/slug, a write mutator (kses-style content
 * stripping, to force verification failures), entity removal mid-flight, and
 * network-level failure via the underlying ScriptedFetch.
 */

import type { Json } from "@/lib/types/db";
import {
  basicAuthHeader,
  type FetchPort,
  type FetchPortResponse,
} from "../shared/http";
import {
  htmlResponse,
  jsonResponse,
  ScriptedFetch,
  type RecordedRequest,
} from "../shared/http-harness";

export interface FakeEntitySeed {
  title: string;
  content?: string;
  meta?: Record<string, Json>;
}

/** The JSON `type` a registered meta key was registered with (show_in_rest). */
export type RegisteredMetaType =
  | "string"
  | "number"
  | "boolean"
  | "array"
  | "object";

export interface FakeWordPressSeed {
  /** Expected raw Basic credential pair, e.g. `gg-operator:xxxx xxxx ...`. */
  credential: string;
  posts?: Record<number, FakeEntitySeed>;
  pages?: Record<number, FakeEntitySeed>;
  media?: Record<number, { altText: string }>;
  /**
   * Registered-meta fidelity mode (real-WP `register_post_meta` behavior).
   * When set, the fake behaves like a site with exactly these meta keys
   * registered for REST, per key with its registered JSON type:
   *  - the rendered `meta` contains ONLY registered keys (unregistered seeded
   *    keys exist in storage but are invisible via REST);
   *  - ZERO registered keys renders `meta` as `[]` — the PHP-empty-array
   *    quirk (an empty PHP assoc array JSON-serializes as an array, not `{}`);
   *  - writes to UNREGISTERED keys are SILENTLY IGNORED (real WP drops them
   *    without an error — the write "succeeds" and echoes an entity that does
   *    not carry the key);
   *  - a write whose value mismatches the registered type fails the WHOLE
   *    request with 400 `rest_invalid_param` (no state change).
   * When omitted (legacy mode), every seeded key is rendered and any key is
   * writable — the pre-fidelity behavior existing tests rely on.
   */
  registeredMeta?: Record<string, RegisteredMetaType>;
}

interface StoredContentEntity {
  kind: "content";
  title: string;
  content: string;
  meta: Record<string, Json>;
}
interface StoredMediaEntity {
  kind: "media";
  altText: string;
}
type StoredEntity = StoredContentEntity | StoredMediaEntity;

const LOGIN_PAGE_HTML =
  '<!DOCTYPE html><html lang="en"><head><title>Log In &lsaquo; Client Site &#8212; WordPress</title></head><body class="login"><form id="loginform" action="wp-login.php"></form></body></html>';

export class FakeWordPress {
  /** The underlying harness — exposed for network-fault injection + journal. */
  readonly http = new ScriptedFetch();

  private readonly credential: string;
  private readonly entities = new Map<string, StoredEntity>();
  private readonly registeredMeta?: Record<string, RegisteredMetaType>;
  private loginRedirect = false;
  private pendingWriteFailure: FetchPortResponse | null = null;
  private writeMutator: ((value: string) => string) | null = null;

  constructor(seed: FakeWordPressSeed) {
    this.credential = seed.credential;
    this.registeredMeta = seed.registeredMeta;
    for (const [id, e] of Object.entries(seed.posts ?? {})) {
      this.entities.set(`posts/${id}`, {
        kind: "content",
        title: e.title,
        content: e.content ?? "",
        meta: { ...(e.meta ?? {}) },
      });
    }
    for (const [id, e] of Object.entries(seed.pages ?? {})) {
      this.entities.set(`pages/${id}`, {
        kind: "content",
        title: e.title,
        content: e.content ?? "",
        meta: { ...(e.meta ?? {}) },
      });
    }
    for (const [id, m] of Object.entries(seed.media ?? {})) {
      this.entities.set(`media/${id}`, { kind: "media", altText: m.altText });
    }
    // One catch-all route: like a real site, EVERY path answers (with the
    // login page when redirect mode is on — regardless of the path asked for).
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

  post(id: number): { title: string; content: string; meta: Record<string, Json> } {
    return this.contentEntity(`posts/${id}`);
  }

  page(id: number): { title: string; content: string; meta: Record<string, Json> } {
    return this.contentEntity(`pages/${id}`);
  }

  media(id: number): { altText: string } {
    const e = this.entities.get(`media/${id}`);
    if (!e || e.kind !== "media") throw new Error(`FakeWordPress: no media ${id}`);
    return { altText: e.altText };
  }

  /* -------- fault injection -------- */

  /** Every request answers 200 + the wp-login HTML page (the classic). */
  simulateLoginRedirect(): this {
    this.loginRedirect = true;
    return this;
  }

  /** The next POST fails once with the given status/slug (state untouched). */
  failNextWriteWith(status = 500, code = "internal_server_error"): this {
    this.pendingWriteFailure = jsonResponse(status, {
      code,
      message: "Internal error",
      data: { status },
    });
    return this;
  }

  /** Mutate every stored string on write — simulates kses/filters altering content. */
  mutateWrites(fn: (value: string) => string): this {
    this.writeMutator = fn;
    return this;
  }

  /** Remove an entity (deleted-behind-our-back scenarios). */
  remove(collection: "posts" | "pages" | "media", id: number): this {
    this.entities.delete(`${collection}/${id}`);
    return this;
  }

  /* -------- request handling -------- */

  private handle(req: RecordedRequest): FetchPortResponse {
    if (this.loginRedirect) return htmlResponse(200, LOGIN_PAGE_HTML);

    if (req.headers["authorization"] !== basicAuthHeader(this.credential)) {
      return jsonResponse(401, {
        code: "incorrect_password",
        message: "The provided password is an invalid application password.",
        data: { status: 401 },
      });
    }

    const path = new URL(req.url).pathname;
    const match = /\/wp-json\/wp\/v2\/(posts|pages|media)\/(\d+)$/.exec(path);
    if (!match) {
      return jsonResponse(404, {
        code: "rest_no_route",
        message: "No route was found matching the URL and request method.",
        data: { status: 404 },
      });
    }

    const key = `${match[1]}/${Number(match[2])}`;
    const entity = this.entities.get(key);
    if (!entity) {
      return jsonResponse(404, {
        code: "rest_post_invalid_id",
        message: "Invalid post ID.",
        data: { status: 404 },
      });
    }

    if (req.method === "POST") {
      if (this.pendingWriteFailure) {
        const failure = this.pendingWriteFailure;
        this.pendingWriteFailure = null;
        return failure;
      }
      const rejected = this.applyUpdate(entity, req.body ?? "{}");
      if (rejected) return rejected;
    }

    return jsonResponse(200, this.render(Number(match[2]), entity));
  }

  /** Merge an update into the entity; a validation failure rejects the WHOLE request. */
  private applyUpdate(
    entity: StoredEntity,
    bodyText: string,
  ): FetchPortResponse | null {
    const body = JSON.parse(bodyText) as { [k: string]: Json };
    const store = (value: Json): Json =>
      this.writeMutator && typeof value === "string"
        ? this.writeMutator(value)
        : value;

    if (entity.kind === "media") {
      if (typeof body.alt_text === "string") {
        entity.altText = store(body.alt_text) as string;
      }
      return null;
    }

    const metaUpdate =
      body.meta !== null && typeof body.meta === "object" && !Array.isArray(body.meta)
        ? (body.meta as Record<string, Json>)
        : undefined;

    // Registered-meta fidelity: type validation happens BEFORE anything
    // mutates (real WP validates params, then applies) — a mismatch fails the
    // whole request with the rest_invalid_param envelope and no state change.
    if (metaUpdate && this.registeredMeta) {
      for (const [k, v] of Object.entries(metaUpdate)) {
        const registeredType = this.registeredMeta[k];
        if (registeredType && !matchesMetaType(v, registeredType)) {
          return jsonResponse(400, {
            code: "rest_invalid_param",
            message: "Invalid parameter(s): meta",
            data: {
              status: 400,
              params: { meta: `meta.${k} is not of type ${registeredType}.` },
            },
          });
        }
      }
    }

    if (typeof body.title === "string") entity.title = store(body.title) as string;
    if (typeof body.content === "string") {
      entity.content = store(body.content) as string;
    }
    if (metaUpdate) {
      for (const [k, v] of Object.entries(metaUpdate)) {
        // Whitelist mode: a write to an UNREGISTERED key is silently ignored,
        // exactly like real WP — no error, no storage, an echo without the key.
        if (this.registeredMeta && !(k in this.registeredMeta)) continue;
        entity.meta[k] = store(v);
      }
    }
    return null;
  }

  private render(id: number, entity: StoredEntity): Json {
    if (entity.kind === "media") {
      return { id, alt_text: entity.altText };
    }
    return {
      id,
      title: { raw: entity.title, rendered: entity.title },
      content: { raw: entity.content, rendered: entity.content },
      meta: this.renderMeta(entity),
    };
  }

  /** The REST view of an entity's meta, honoring registered-meta fidelity. */
  private renderMeta(entity: StoredContentEntity): Json {
    if (!this.registeredMeta) return { ...entity.meta }; // legacy mode
    const keys = Object.keys(this.registeredMeta);
    // The PHP-empty-array quirk: a post type with NO registered meta
    // serializes its empty meta map as `[]`, not `{}`.
    if (keys.length === 0) return [];
    const rendered: Record<string, Json> = {};
    for (const key of keys) {
      rendered[key] = Object.prototype.hasOwnProperty.call(entity.meta, key)
        ? entity.meta[key]
        : metaTypeDefault(this.registeredMeta[key]);
    }
    return rendered;
  }

  private contentEntity(key: string): {
    title: string;
    content: string;
    meta: Record<string, Json>;
  } {
    const e = this.entities.get(key);
    if (!e || e.kind !== "content") {
      throw new Error(`FakeWordPress: no content entity at ${key}`);
    }
    return { title: e.title, content: e.content, meta: { ...e.meta } };
  }
}

/** Does a JSON value satisfy a registered meta type? (WP's param validation.) */
function matchesMetaType(value: Json, type: RegisteredMetaType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
  }
}

/** REST default for a registered-but-never-written meta key (fresh per render). */
function metaTypeDefault(type: RegisteredMetaType): Json {
  switch (type) {
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return {};
  }
}
