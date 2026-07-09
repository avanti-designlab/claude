/**
 * Typed failure contract for write-method adapters (doc 04 §1) — shared by
 * WordPress / Webflow / Wix / edge-worker so callers, the QA rollback suite,
 * and the operator UI can react to WHAT failed without ever parsing a vendor
 * payload. The change-management pipeline treats adapter errors as opaque
 * (`asError`), so this family is additive: it refines, it never requires a
 * pipeline change.
 *
 * Failure honesty rules (doc 04 §5):
 *  - Messages are COMPOSED here from our own coordinates (operation, origin,
 *    HTTP status, a sanitized vendor error slug) — never from raw vendor
 *    response bodies, and never from credentials. A credential cannot appear
 *    in a WriteMethodError by construction.
 *  - Messages are interface-voice: they tell the operator what happened and
 *    what to do, not which internal function threw.
 */

import type { SiteChangeMethod } from "@/lib/types/db";

/** Stable machine-readable codes for every way a write method can refuse/fail. */
export type WriteMethodErrorCode =
  /** The adapter was constructed with an unusable site config (bad base URL, creds in URL, ...). */
  | "misconfigured"
  /** The target/locator names an operation this method cannot perform reversibly — rejected at plan time. */
  | "unsupported_operation"
  /** A before/after value is not installable byte-exact for this operation — rejected at plan time, never at rollback time. */
  | "invalid_value"
  /** The call's AdapterContext does not match the property this adapter is pinned to. */
  | "property_mismatch"
  /** The target URL is not on this adapter's pinned site origin — a write never crosses origins. */
  | "cross_site_target"
  /** The site refused our credentials (HTTP 401/403) — revoked/insufficient application password. */
  | "credential_rejected"
  /** The target does not exist on the site (HTTP 404, or a meta field not exposed via REST). */
  | "target_missing"
  /** The site answered with something other than the expected REST JSON (the classic wp-login HTML redirect). */
  | "unexpected_response"
  /**
   * The vendor's API rate limit rejected the call (HTTP 429). The operation
   * did NOT happen: the pipeline leaves the change row in its pre-call status
   * ('previewed' for a failed apply, 'applied' for a failed revert), so the
   * SAME action can simply be re-run once the window passes. NOTHING retries
   * automatically — an unattended retry loop would be an unattended write.
   * `retryAfterSeconds` carries the vendor's advisory wait when one was given.
   */
  | "rate_limited"
  /** The site's API errored (5xx / unexpected status with a parseable error envelope). */
  | "vendor_failure"
  /** The site could not be reached at all (DNS, TLS, timeout — the fetch itself threw). */
  | "network_failure"
  /** The site stored a DIFFERENT value than the one written — byte-exactness is broken; the write is reported failed. */
  | "write_verification_failed";

/** Optional structured detail — safe-by-construction (status + sanitized slug only). */
export interface WriteMethodErrorDetail {
  /** HTTP status that produced the failure, when one exists. */
  httpStatus?: number;
  /** Sanitized vendor error slug (e.g. WordPress's `rest_cannot_edit`). */
  vendorCode?: string;
  /**
   * Seconds the vendor asked us to wait (a `rate_limited` failure whose
   * Retry-After header was a plain integer — anything else is dropped, never
   * echoed). Advisory for the operator/queue; the pipeline never sleeps-and-
   * retries on its own.
   */
  retryAfterSeconds?: number;
}

export class WriteMethodError extends Error {
  readonly code: WriteMethodErrorCode;
  readonly method: SiteChangeMethod;
  readonly httpStatus?: number;
  readonly vendorCode?: string;
  readonly retryAfterSeconds?: number;

  constructor(
    method: SiteChangeMethod,
    code: WriteMethodErrorCode,
    message: string,
    detail?: WriteMethodErrorDetail,
  ) {
    super(message);
    this.name = "WriteMethodError";
    this.method = method;
    this.code = code;
    this.httpStatus = detail?.httpStatus;
    this.vendorCode = detail?.vendorCode;
    this.retryAfterSeconds = detail?.retryAfterSeconds;
  }
}

/** Family guard for callers holding an `unknown` (e.g. `BatchApplyReport.failed.error`). */
export function isWriteMethodError(err: unknown): err is WriteMethodError {
  return err instanceof WriteMethodError;
}

/**
 * Extract a vendor error slug SAFELY: only a short machine-style identifier
 * (letters/digits/underscore/hyphen) survives; anything else — including a
 * vendor's free-text message, which could echo page content or worse — is
 * dropped. This is the only piece of a vendor response body that may ever
 * appear in a WriteMethodError.
 */
export function safeVendorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    ? value
    : undefined;
}

/** Machine-style Node/undici error codes (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, ...). */
const TRANSPORT_CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
/** A plain identifier-shaped error class name (TypeError, AbortError, ...). */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * Reduce a transport-level throw (the fetch itself rejected) to a WHITELISTED
 * identifier that is safe to compose into an interface-voice message. A
 * transport error's free-text `message` is NEVER used — DNS resolvers,
 * proxies, and middleboxes put arbitrary text (hostnames, redirect locations,
 * proxy banners) in there, and none of it may leak into a WriteMethodError.
 * Only two shapes survive: a machine-style `code` (Node/undici sets it on the
 * error or its `cause`: ENOTFOUND, ECONNREFUSED, ETIMEDOUT, ...) or, failing
 * that, the error's class NAME when it is identifier-shaped and more specific
 * than plain `Error` (e.g. the TypeError a refused redirect rejects with).
 */
export function safeTransportDetail(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = transportCodeOf(err) ?? transportCodeOf(err.cause);
  if (code) return code;
  return err.name !== "Error" && ERROR_NAME.test(err.name)
    ? err.name
    : undefined;
}

function transportCodeOf(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && TRANSPORT_CODE.test(code)
    ? code
    : undefined;
}
