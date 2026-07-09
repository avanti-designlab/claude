/**
 * Shared foundation for the 1.3 write methods (doc 04 §1) — the pieces that
 * must NOT be forked per method: the typed failure contract, the injected
 * HTTP port, and the scripted-HTTP test harness. WordPress ships first;
 * Webflow / Wix / edge-worker build on exactly these.
 */

export {
  WriteMethodError,
  isWriteMethodError,
  safeTransportDetail,
  safeVendorCode,
  type WriteMethodErrorCode,
  type WriteMethodErrorDetail,
} from "./errors";

export {
  basicAuthHeader,
  bearerAuthHeader,
  looksLikeHtml,
  tryParseJson,
  type FetchPort,
  type FetchPortInit,
  type FetchPortResponse,
  type ParsedJson,
} from "./http";

export {
  ScriptedFetch,
  jsonResponse,
  htmlResponse,
  textResponse,
  type RecordedRequest,
  type ScriptedHandler,
} from "./http-harness";
