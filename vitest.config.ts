import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    // The tenant-isolation suite (supabase/tests/) needs a live Postgres and
    // runs via `npm run test:isolation` (vitest.isolation.config.ts) — kept
    // out of the default run so it can never silently skip. See doc 03 §7.
    include: ["src/**/*.test.ts"],
  },
});
