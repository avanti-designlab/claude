import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Tenant-isolation suite (doc 03 §7 freeze criterion; QA agent's "can never
 * fail silently" suite). Requires a live Postgres — connection via
 * ISOLATION_DATABASE_URL (defaults documented in supabase/tests/README.md).
 * Deliberately separate from the default `npm test` run: a missing database
 * must FAIL this suite loudly, never skip it.
 */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["supabase/tests/**/*.test.ts"],
    // Migrations + RLS assertions share one database; run serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
