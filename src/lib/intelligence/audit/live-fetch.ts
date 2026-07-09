import "server-only";

/**
 * Production FetchPort for the audit crawler — the platform `fetch` itself.
 *
 * The shared port contract (src/lib/write-methods/shared/http.ts) is designed
 * so global fetch satisfies it structurally: no wrapper logic to maintain,
 * and `redirect: "error"` is enforced per-request by the crawler. This tiny
 * module exists ONLY as the injection seam — action tests vi.mock it to hand
 * the crawler a ScriptedFetch port, so no test ever touches live network.
 */

import type { FetchPort } from "@/lib/write-methods/shared";

export function liveFetchPort(): FetchPort {
  return fetch;
}
