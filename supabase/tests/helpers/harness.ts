/**
 * F1 tenant-isolation test harness (build step 0.3, doc 03 §7).
 *
 * Reusable foundation for the QA agent's adversarial isolation suite:
 * - fresh scratch database per run, created/dropped via the admin connection
 *   (ISOLATION_DATABASE_URL — a superuser connection);
 * - Supabase-exact auth shim: `create schema auth` + `auth.jwt()` reading
 *   `request.jwt.claims`. Installed ONLY here — migrations never create the
 *   auth schema (it is Supabase-provided in real environments);
 * - NOLOGIN cluster roles `authenticated` / `anon` pre-created BEFORE
 *   migrations run (migration grants reference them);
 * - `queryAs(...)` to run any statement AS a database role WITH a JWT claims
 *   set, mirroring how PostgREST executes requests.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type QueryResult, type QueryResultRow } from "pg";
import type { JwtClaims, JwtRole } from "@/lib/types/db";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations"
);

/** Documented default — see supabase/tests/README.md. */
export const DEFAULT_ADMIN_URL =
  "postgresql://postgres:postgres@127.0.0.1:5432/isolation_test";

export function adminDatabaseUrl(): string {
  return process.env.ISOLATION_DATABASE_URL ?? DEFAULT_ADMIN_URL;
}

/**
 * All tables of the F1 schema (doc 03 §3) + the governed post-freeze additions
 * (competitors 0010, runs 0011, brand_assets 0014, brand_extract_drafts 0015),
 * in dependency order (parents before children — brand_extract_drafts FKs both
 * clients and runs, so it lands last).
 */
export const ALL_TABLES = [
  "tenants",
  "tenant_users",
  "clients",
  "properties",
  "brand_kits",
  "brand_assets",
  "plans",
  "tasks",
  "audits",
  "content_items",
  "site_changes",
  "visibility_results",
  "metrics",
  "alerts",
  "competitors",
  "runs",
  "brand_extract_drafts",
] as const;
export type TableName = (typeof ALL_TABLES)[number];

/** Tables carrying a tenant_id column (all but the tenancy root itself). */
export const TENANT_ID_TABLES = ALL_TABLES.filter(
  (t) => t !== "tenants"
) as readonly Exclude<TableName, "tenants">[];

/**
 * Tables whose reads are client_viewer-SCOPED (own-client only, via
 * app.client_scope). `competitors` joins them (M19 renders share-of-voice).
 * `runs` and `brand_extract_drafts` are intentionally NOT here: each carries a
 * client_id column for tenant-consistency but its SELECT is writer-only (the
 * internal scan queue / the pre-approval brand-extract drafts), so — like
 * `tenant_users` — they are client_id-bearing tables that are not client_viewer
 * surfaces (see posture.test.ts).
 */
export const CLIENT_SCOPED_TABLES = [
  "clients",
  "properties",
  "brand_kits",
  "brand_assets",
  "plans",
  "tasks",
  "audits",
  "content_items",
  "site_changes",
  "visibility_results",
  "metrics",
  "alerts",
  "competitors",
] as const;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/**
 * Cluster roles Supabase provides. Created idempotently (roles are
 * cluster-wide, so a previous run may have created them already).
 * MUST run before migrations — the migration grants reference these roles.
 *
 * `supabase_auth_admin` is the role GoTrue uses to invoke the Custom Access
 * Token hook (migration 0007). Like `authenticated` / `anon`, it is
 * Supabase-provided in real projects; the harness pre-creates it so 0007's
 * grants resolve. NOLOGIN — the hook is SECURITY DEFINER, so the table read
 * happens as the definer, not as this role (it only needs EXECUTE + schema
 * usage, granted by the migration).
 *
 * `service_role` is Supabase-provided (BYPASSRLS) and is the role the run-queue
 * processor SET ROLEs to when calling the queue-infra SECURITY DEFINER functions
 * (migration 0012 grants EXECUTE on lease_next_run / reap_orphaned_runs /
 * requeue_failed_runs to it). Pre-created here BEFORE migrations so those grants
 * resolve, and so the QA suite can prove the EXECUTE lockdown (only service_role
 * may call them; authenticated/anon cannot). BYPASSRLS mirrors real Supabase;
 * the functions are SECURITY DEFINER regardless, so they run as the owner.
 */
export async function ensureDbRoles(client: Client): Promise<void> {
  await client.query(`
    do $$
    begin
      if not exists (select from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
      if not exists (select from pg_roles where rolname = 'anon') then
        create role anon nologin;
      end if;
      if not exists (select from pg_roles where rolname = 'supabase_auth_admin') then
        create role supabase_auth_admin nologin noinherit;
      end if;
      if not exists (select from pg_roles where rolname = 'service_role') then
        create role service_role nologin noinherit bypassrls;
      end if;
    end
    $$;
  `);
}

/**
 * Supabase-exact auth shim. Mirrors Supabase's own definition of auth.jwt()
 * (request.jwt.claims GUC, with the legacy singular fallback). Installed only
 * by the harness — never by migrations.
 */
export async function installAuthShim(client: Client): Promise<void> {
  await client.query(`
    create schema if not exists auth;

    create or replace function auth.jwt() returns jsonb
    language sql stable
    as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
      )::jsonb
    $$;

    grant usage on schema auth to authenticated, anon;
    grant execute on function auth.jwt() to authenticated, anon;
  `);
}

/** Apply every supabase/migrations/*.sql in filename order. */
export async function applyMigrations(client: Client): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    try {
      await client.query(sql);
    } catch (err) {
      throw new Error(
        `migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
  }
  return files;
}

export interface IsolationDb {
  /**
   * Superuser connection to the scratch database. Superusers bypass RLS —
   * use for seeding and catalog assertions only; use queryAs() for anything
   * that must exercise policies.
   */
  admin: Client;
  name: string;
  url: string;
  /** Applied migration filenames, in order. */
  migrations: string[];
  teardown(): Promise<void>;
}

/**
 * One call: scratch database + roles + auth shim + migrations.
 * Call `teardown()` when done — it drops the scratch database.
 */
export async function setupIsolationDb(): Promise<IsolationDb> {
  const baseUrl = adminDatabaseUrl();
  const name = `isolation_run_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const control = new Client({ connectionString: baseUrl });
  await control.connect();
  try {
    await ensureDbRoles(control);
    await control.query(`create database ${quoteIdent(name)}`);
  } finally {
    await control.end();
  }

  const url = withDatabase(baseUrl, name);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    await installAuthShim(admin);
    const migrations = await applyMigrations(admin);
    return {
      admin,
      name,
      url,
      migrations,
      teardown: async () => {
        await admin.end();
        const cleanup = new Client({ connectionString: baseUrl });
        await cleanup.connect();
        try {
          await cleanup.query(
            `drop database if exists ${quoteIdent(name)} with (force)`
          );
        } finally {
          await cleanup.end();
        }
      },
    };
  } catch (err) {
    await admin.end();
    throw err;
  }
}

/**
 * Live catalog introspection — the source of truth for the QA sweeps.
 *
 * The isolation suites drive their table loops off THIS (the live schema),
 * not off the hardcoded constants, so a future table added to a migration is
 * swept automatically. `posture.test.ts` then asserts the live sets equal the
 * documented `ALL_TABLES` / `TENANT_ID_TABLES` / `CLIENT_SCOPED_TABLES`
 * constants — so a new table without coverage fails the suite by DEFAULT
 * (drift is loud), rather than silently escaping the attack sweeps.
 */
export interface SchemaIntrospection {
  /** Every base table in `public`. */
  tables: string[];
  /** Tables carrying a `tenant_id` column. */
  tenantIdTables: string[];
  /** Tables carrying a `client_id` column. */
  clientIdTables: string[];
}

export async function introspectSchema(
  client: Client
): Promise<SchemaIntrospection> {
  const tablesRes = await client.query<{ tablename: string }>(
    `select tablename from pg_tables
     where schemaname = 'public' order by tablename`
  );
  const colsRes = await client.query<{ table_name: string; column_name: string }>(
    `select c.relname as table_name, a.attname as column_name
     from pg_attribute a
     join pg_class c on c.oid = a.attrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and a.attnum > 0 and not a.attisdropped
       and a.attname in ('tenant_id', 'client_id')`
  );
  return {
    tables: tablesRes.rows.map((r) => r.tablename).sort(),
    tenantIdTables: colsRes.rows
      .filter((r) => r.column_name === "tenant_id")
      .map((r) => r.table_name)
      .sort(),
    clientIdTables: colsRes.rows
      .filter((r) => r.column_name === "client_id")
      .map((r) => r.table_name)
      .sort(),
  };
}

/** The database roles a request can execute as (PostgREST model). */
export type DbRole = "authenticated" | "anon";

/**
 * Run one statement AS a database role WITH the given JWT claims — exactly
 * how Supabase/PostgREST executes a request: claims into request.jwt.claims,
 * SET ROLE, run, reset. Committed on success so seeded-through-RLS writes
 * persist; rolled back (and the error rethrown) on failure.
 */
export async function queryAs<T extends QueryResultRow = QueryResultRow>(
  client: Client,
  role: DbRole,
  claims: JwtClaims | Record<string, unknown> | null,
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  await client.query("begin");
  try {
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      claims ? JSON.stringify(claims) : "",
    ]);
    await client.query(
      `set local role ${role === "anon" ? "anon" : "authenticated"}`
    );
    const result = await client.query<T>(text, params);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

/**
 * Invoke the Custom Access Token hook (migration 0007) exactly as GoTrue does:
 * as `supabase_auth_admin` (the default), or as another role to prove the
 * EXECUTE grant is locked down. Returns the hook's full return value; read the
 * minted claims off `.claims`. Runs in its own transaction and resets the role.
 *
 * `event` is the GoTrue hook payload: { user_id, claims?, ... }. The hook is
 * SECURITY DEFINER, so the tenant_users read runs as the definer regardless of
 * the calling `as` role.
 */
export async function callAccessTokenHook(
  client: Client,
  event: Record<string, unknown>,
  opts: { as?: "supabase_auth_admin" | DbRole } = {}
): Promise<{ claims: Record<string, unknown>; [key: string]: unknown }> {
  const as = opts.as ?? "supabase_auth_admin";
  await client.query("begin");
  try {
    await client.query(`set local role ${as}`);
    const res = await client.query<{ out: Record<string, unknown> }>(
      `select auth_hooks.custom_access_token_hook($1::jsonb) as out`,
      [JSON.stringify(event)]
    );
    await client.query("commit");
    return res.rows[0].out as {
      claims: Record<string, unknown>;
      [key: string]: unknown;
    };
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

/**
 * Convenience claims builder for the REAL production token shape RLS keys off.
 * The APP role travels in the NON-reserved `user_role` claim (app.user_role()
 * reads it — migration 0008), exactly as the Custom Access Token hook mints it.
 * `role` stays GoTrue's reserved DB-role claim ('authenticated') — PostgREST's
 * `SET ROLE` target, which queryAs()'s `set local role authenticated` mirrors.
 * Emitting both makes the isolation suite exercise the production claim shape
 * and proves RLS reads `user_role`, never the reserved `role`.
 */
export function claimsFor(
  role: JwtRole,
  tenantId: string,
  opts: { clientId?: string; sub?: string } = {}
): JwtClaims {
  const claims: JwtClaims = {
    tenant_id: tenantId,
    role: "authenticated",
    user_role: role,
  };
  if (opts.clientId !== undefined) claims.client_id = opts.clientId;
  if (opts.sub !== undefined) claims.sub = opts.sub;
  return claims;
}

/**
 * Assert helper for the QA suite: run and expect a Postgres error whose
 * message matches. Returns the error message on match; throws otherwise.
 */
export async function expectQueryRejected(
  client: Client,
  role: DbRole,
  claims: JwtClaims | Record<string, unknown> | null,
  text: string,
  params: unknown[] | undefined,
  messagePattern: RegExp
): Promise<string> {
  try {
    await queryAs(client, role, claims, text, params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (messagePattern.test(message)) return message;
    throw new Error(
      `query rejected, but for the wrong reason.\n  expected: ${messagePattern}\n  actual: ${message}`
    );
  }
  throw new Error(
    `query unexpectedly succeeded (expected rejection matching ${messagePattern}): ${text}`
  );
}
