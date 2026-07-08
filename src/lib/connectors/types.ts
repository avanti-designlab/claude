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
 * the duration of a single vendor call inside the adapter. `toString` is
 * masked so a stray interpolation cannot leak the secret.
 */
export class VendorCredential {
  private readonly secret: string;
  constructor(secret: string) {
    this.secret = secret;
  }
  /** Reveal the raw value — only inside an adapter, only at call time. */
  reveal(): string {
    return this.secret;
  }
  toString(): string {
    return "VendorCredential(***)";
  }
  toJSON(): string {
    return "***";
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
