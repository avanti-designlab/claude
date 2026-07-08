/**
 * Provider-agnostic connector foundation (doc 04 §7).
 *
 * "Buy now, maybe build later" stays cheap only if every rented data source sits
 * behind a provider-agnostic interface. Modules (M3 tracker, M11 social) call the
 * INTERFACE, never a vendor SDK — a vendor SDK import OUTSIDE its adapter is a
 * Code Review rejection. Swapping vendors changes one adapter, not any module or
 * the data model.
 *
 * This file holds the pieces every connector shares: tenant scoping and the
 * secrets-vault resolution port. Credentials are resolved at CALL TIME and are
 * NEVER logged, returned to a client, or stored in a table (doc 03 §5, doc 04 §5).
 */

/** Every connector call is tenant-scoped (doc 04 §5). */
export interface ConnectorScope {
  tenantId: string;
  clientId: string;
}

/**
 * An opaque, resolved credential. Never persisted, never logged. Held only for
 * the duration of a single vendor call inside the adapter.
 *
 * The raw secret CANNOT leak through any standard logging path:
 *  - it lives in an ES private field (`#secret`), so it is non-enumerable and
 *    never appears as an own property — `console.log(cred)` / `util.inspect`
 *    have nothing to print, and `JSON.stringify` never serializes it;
 *  - `[nodejs.util.inspect.custom]` masks the console.log / util.inspect path;
 *  - `toString` masks string interpolation; `toJSON` masks JSON serialization.
 *
 * The value is reachable ONLY via {@link VendorCredential.reveal}, which call
 * sites invoke at USE TIME inside an adapter (never storing or logging the
 * revealed string). A `secrets.test.ts` proves the raw secret appears in none
 * of util.inspect / String() / JSON.stringify / template / console.log.
 */
export class VendorCredential {
  readonly #secret: string;
  constructor(secret: string) {
    this.#secret = secret;
  }
  /**
   * Reveal the raw value — only inside an adapter, only at call time. The
   * returned string must be handed straight to the vendor call and never
   * logged, stored, or retained past the call.
   */
  reveal(): string {
    return this.#secret;
  }
  toString(): string {
    return "VendorCredential(***)";
  }
  toJSON(): string {
    return "***";
  }
  /** Masks the console.log / util.inspect path (the leak the private field also closes). */
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "VendorCredential(***)";
  }
}

/**
 * Resolves a `properties.auth_ref` (or a tenant-level key ref) to a live
 * credential from the secrets vault, tenant-scoped. The real implementation
 * (Supabase Vault / external manager, DevOps-owned) lands with the write
 * methods in 1.3; adapters depend on THIS interface, not on the vault directly.
 */
export interface SecretsResolver {
  resolve(authRef: string, scope: ConnectorScope): Promise<VendorCredential>;
}

/**
 * A provider adapter that needs vendor credentials receives the resolver +
 * an auth ref, and resolves lazily inside each call. Provider-agnostic modules
 * never see this — they only ever hold the provider interface.
 */
export interface CredentialedAdapterConfig {
  secrets: SecretsResolver;
  /** The secrets-vault reference for this connection (never a raw key). */
  authRef: string;
}
