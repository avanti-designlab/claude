/**
 * Provider-agnostic connector interfaces (doc 04 §7; doc 07 §1.2).
 *
 * The build-vs-buy hedge: rented data sources (citation data, social
 * posting) sit behind these interfaces so swapping vendors — or swapping in
 * our own engine later — changes one adapter, not the modules.
 *
 * Rules (doc 04 §7, enforced at Code Review):
 * - Modules (M3 tracker, M4 competitor, M11 social) import from HERE, never
 *   a vendor SDK. A vendor SDK import outside its adapter is a rejection.
 * - Every vendor response is normalized into our own schema before storage
 *   (`toVisibilityResultInsert` → `visibility_results`), so stored history
 *   is vendor-independent and survives a vendor switch.
 * - Vendor keys live in the secrets vault, per-tenant where the tenant
 *   supplies their own (doc 04 §5) — adapters resolve them at call time.
 *
 * NOTE: client-site WRITE methods are NOT connectors — they live behind the
 * change-management pipeline (`@/lib/change-management`), which is the only
 * public write surface for client sites (doc 04 §2).
 */

export {
  InMemoryCitationDataProvider,
  toVisibilityResultInsert,
  UNCITED_RESULT,
  type CitationDataProvider,
  type CitationGeo,
  type CitationPromptRequest,
  type CitationPromptResult,
  type CitationScript,
  type VisibilityResultInsert,
} from "./citation-data";

export {
  InMemorySocialPostingProvider,
  type ScheduledPost,
  type SocialAccountRef,
  type SocialAsset,
  type SocialPostingProvider,
  type SocialPostReceipt,
  type SocialPostRequest,
} from "./social-posting";

// Secrets-vault seam (doc 03 §5, doc 04 §5): adapters resolve credentials at
// call time via SecretsResolver; VendorCredential is masked so a stray log or
// interpolation can never leak the raw key. Real vault-backed resolvers land
// with the first live adapter (M3 at 1.4 / M11 at 1.7).
export {
  VendorCredential,
  type ConnectorScope,
  type SecretsResolver,
  type CredentialedAdapterConfig,
} from "./types";
