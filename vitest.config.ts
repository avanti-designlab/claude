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
    // workers/edge-autofix is the Cloudflare edge write method (1.3): its
    // manifest/rule logic is pure TypeScript tested here in plain vitest —
    // no miniflare/workerd (CF-only surfaces are injected interfaces).
    include: ["src/**/*.test.ts", "workers/edge-autofix/src/**/*.test.ts"],
  },
});
