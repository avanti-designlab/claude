/**
 * SSRF egress guard for the audit crawler (doc 05 M2; Code Review 9e83459 MAJOR).
 *
 * The crawler fetches a property URL SERVER-SIDE. Without this guard a stored
 * property URL like `http://169.254.169.254/…` (cloud metadata), `http://localhost`,
 * `http://10.x`, `http://[::1]`, or a public hostname that RESOLVES to an
 * internal address, would be fetched from inside our network — the classic SSRF
 * pivot. Redirect-escape and off-origin link-pivot are already closed upstream
 * (`redirect:"error"` on the port + same-origin refusal in the crawler); this
 * module closes the remaining hole: the DIRECT internal target reached via the
 * property URL or via DNS resolution.
 *
 * TWO verdicts, in order:
 *
 *  1. `hostIsBlockedLiteral(host)` — SYNCHRONOUS, pre-DNS. Rejects IP-literal
 *     hosts (incl. bracketed IPv6) that fall in a blocked range, plus the RFC
 *     6761 loopback NAME `localhost` / `*.localhost` (always loopback; we never
 *     depend on DNS to discover that). This alone stops every literal attack
 *     vector: 127.0.0.1, ::1, 169.254.169.254, 10.x, 192.168.x, 172.16-31.x, …
 *
 *  2. `checkEgressHost(host, resolve)` — for DNS hostnames: resolves via the
 *     INJECTED resolver port (`ResolvePort`; production = node
 *     `dns.promises.lookup(host,{all:true})` behind the live-fetch seam, a fake
 *     in tests) and rejects if ANY resolved address is blocked. A public IP
 *     literal short-circuits (already an address — no DNS). A resolver failure
 *     or an empty answer is treated as NOT crawlable (fail closed).
 *
 * Blocked ranges (`isBlockedAddress`):
 *   IPv4 — 0.0.0.0/8 (this-net + unspecified), 10/8·172.16/12·192.168/16
 *   (RFC1918), 100.64/10 (CGNAT), 127/8 (loopback), 169.254/16 (link-local),
 *   192.0.0/24 (IETF), 198.18/15 (benchmark), 224/4 (multicast),
 *   240/4 (reserved/future, incl. 255.255.255.255 broadcast).
 *   IPv6 — ::/128 (unspecified) & ::1/128 (loopback) & IPv4-compat, fe80::/10
 *   (link-local), fc00::/7 (ULA), ff00::/8 (multicast), and IPv4-mapped
 *   ::ffff:0:0/96 — mapped/compat embeds are UNWRAPPED and re-checked as v4.
 *
 * ── RESIDUAL: DNS-rebinding TOCTOU ──────────────────────────────────────────
 * `checkEgressHost` resolves the host and then the crawler's own fetch resolves
 * it AGAIN — two separate lookups. A hostile authoritative server can answer
 * "public" for our check and "127.0.0.1" for the fetch (short-TTL rebinding),
 * so a determined attacker retains a narrow time-of-check/time-of-use window.
 * We name it rather than hide it (the CF/Wix honest-residual pattern). The
 * fully robust close PINS the connection to the exact IP we checked — an undici
 * custom `lookup`/dispatcher that hands the socket the vetted address — which
 * is heavier wiring deferred to the live-fetch seam; this guard closes the
 * whole DIRECT/first-resolution class, which was the open MAJOR.
 */

/** One resolved address (node `dns.lookup` `{all:true}` entry shape). */
export interface ResolvedAddress {
  address: string;
  family?: number;
}

/**
 * Injected DNS resolver. Production wires node
 * `dns.promises.lookup(host,{all:true})` behind the live-fetch seam; tests pass
 * a fake. The crawler NEVER imports node dns directly — same port discipline as
 * the FetchPort, so no test touches live DNS.
 */
export type ResolvePort = (hostname: string) => Promise<ResolvedAddress[]>;

/* ------------------------------------------------------------------ */
/* IPv4                                                                */
/* ------------------------------------------------------------------ */

/**
 * Parse a canonical dotted-decimal IPv4 string to a 32-bit int, or null.
 * Inputs reach us already normalized (WHATWG `URL` canonicalizes octal/hex/
 * decimal literal forms to dotted-decimal; the resolver returns canonical
 * addresses), so strict decimal parsing is sufficient and safe.
 */
function parseIPv4(s: string): number | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

function cidr(base: string, bits: number): [network: number, mask: number] {
  const b = parseIPv4(base);
  if (b === null) throw new Error(`egress-guard: bad CIDR base ${base}`);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [(b & mask) >>> 0, mask];
}

/** Blocked IPv4 ranges — never a legitimate public crawl target. */
const V4_BLOCKED: ReadonlyArray<readonly [number, number]> = [
  cidr("0.0.0.0", 8), // "this" network + 0.0.0.0 unspecified
  cidr("10.0.0.0", 8), // RFC1918 private
  cidr("100.64.0.0", 10), // CGNAT (RFC6598)
  cidr("127.0.0.0", 8), // loopback
  cidr("169.254.0.0", 16), // link-local
  cidr("172.16.0.0", 12), // RFC1918 private
  cidr("192.0.0.0", 24), // IETF protocol assignments
  cidr("192.168.0.0", 16), // RFC1918 private
  cidr("198.18.0.0", 15), // benchmarking
  cidr("224.0.0.0", 4), // multicast
  cidr("240.0.0.0", 4), // reserved/future (incl. 255.255.255.255 broadcast)
];

function isBlockedV4(v: number): boolean {
  for (const [network, mask] of V4_BLOCKED) {
    if (((v & mask) >>> 0) === network) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* IPv6                                                                */
/* ------------------------------------------------------------------ */

/** Parse an IPv6 literal (incl. `::` compression + embedded IPv4) to 16 bytes. */
function parseIPv6(input: string): Uint8Array | null {
  let s = input.trim().toLowerCase();
  const zone = s.indexOf("%"); // strip scope/zone id (fe80::1%eth0)
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":")) return null;

  // Fold a trailing embedded IPv4 ("::ffff:1.2.3.4") into two hex groups.
  if (s.includes(".")) {
    const lastColon = s.lastIndexOf(":");
    const v4 = parseIPv4(s.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  let groups: string[];
  const dbl = s.indexOf("::");
  if (dbl !== -1) {
    if (s.indexOf("::", dbl + 1) !== -1) return null; // only one "::" allowed
    const head = s.slice(0, dbl) === "" ? [] : s.slice(0, dbl).split(":");
    const tail = s.slice(dbl + 2) === "" ? [] : s.slice(dbl + 2).split(":");
    const missing = 8 - (head.length + tail.length);
    if (missing < 1) return null; // "::" must stand for ≥1 zero group
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = s.split(":");
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    bytes[i * 2] = (n >>> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

function allZero(b: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) if (b[i] !== 0) return false;
  return true;
}

function v4At(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function isBlockedV6(b: Uint8Array): boolean {
  // IPv4-mapped ::ffff:0:0/96 — unwrap and re-check the embedded v4.
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedV4(v4At(b, 12));
  }
  // Low ::/96 — covers ::(unspecified), ::1(loopback), deprecated IPv4-compat;
  // all map into 0.0.0.0/8, which is blocked.
  if (allZero(b, 0, 12)) {
    return isBlockedV4(v4At(b, 12));
  }
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // link-local fe80::/10
  if ((b[0] & 0xfe) === 0xfc) return true; // unique-local fc00::/7
  if (b[0] === 0xff) return true; // multicast ff00::/8
  return false;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function stripBrackets(host: string): string {
  const h = host.trim();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

/** Is `s` an IP literal (either family)? */
function isIpLiteral(s: string): boolean {
  return parseIPv4(s) !== null || parseIPv6(s) !== null;
}

/**
 * Is this IP in a blocked (non-public) range? PURE. Expects an IP string
 * (dotted-decimal IPv4 or IPv6 literal); anything that does not parse as an IP
 * is treated as blocked (fail closed — a security guard never vouches for what
 * it cannot classify). Callers pass either a URL hostname already confirmed to
 * be an IP literal, or an address returned by the resolver.
 */
export function isBlockedAddress(ip: string): boolean {
  const stripped = stripBrackets(ip);
  const v4 = parseIPv4(stripped);
  if (v4 !== null) return isBlockedV4(v4);
  const v6 = parseIPv6(stripped);
  if (v6 !== null) return isBlockedV6(v6);
  return true; // unparseable → fail closed
}

/**
 * SYNCHRONOUS, pre-DNS verdict on a URL hostname. Rejects:
 *  - the reserved loopback name `localhost` / `*.localhost` (RFC 6761), and
 *  - IP-literal hosts (incl. bracketed IPv6) that fall in a blocked range.
 * Returns false for a public IP literal AND for any DNS hostname — those need
 * `checkEgressHost` (the DNS-resolving path) to decide.
 */
export function hostIsBlockedLiteral(host: string): boolean {
  const h = stripBrackets(host).toLowerCase();
  if (h === "") return true; // empty host is never a crawl target
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (!isIpLiteral(h)) return false; // DNS name — sync path can't decide
  return isBlockedAddress(h);
}

/**
 * Full egress verdict for a URL hostname. Returns true only if the host is
 * safe to fetch. Order:
 *  1. synchronous literal/localhost rejection (`hostIsBlockedLiteral`);
 *  2. a non-blocked IP LITERAL is already an address → allow, no DNS;
 *  3. a DNS hostname is resolved via the injected port and allowed only when
 *     it answers with ≥1 address and EVERY address is public.
 * Fail closed: a resolver throw, an empty answer, or a malformed entry → false.
 */
export async function checkEgressHost(host: string, resolve: ResolvePort): Promise<boolean> {
  if (hostIsBlockedLiteral(host)) return false;
  const stripped = stripBrackets(host);
  if (isIpLiteral(stripped)) return true; // public IP literal — no DNS needed

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(stripped);
  } catch {
    return false; // cannot verify → not crawlable
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return false;
  for (const entry of addresses) {
    if (typeof entry?.address !== "string" || isBlockedAddress(entry.address)) {
      return false;
    }
  }
  return true;
}
