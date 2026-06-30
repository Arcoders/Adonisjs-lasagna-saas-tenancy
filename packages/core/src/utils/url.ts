import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * Reject URLs that would let a caller pivot the package's outbound fetcher
 * (webhook delivery, OIDC discovery) at internal infrastructure.
 *
 * Rules:
 *   - scheme MUST be `https:` (no http/file/gopher/ftp/data)
 *   - the host MUST NOT be (or resolve, syntactically, to) loopback,
 *     link-local, RFC 1918 / ULA private ranges, CGN, multicast/reserved, or
 *     a cloud-metadata IP — checked for IPv4, IPv6, and IPv4-mapped IPv6 in
 *     ANY notation (`net.isIP` canonicalises the literal first)
 *   - the host MUST NOT be an ambiguous numeric encoding of an IP (a bare
 *     decimal `2130706433`, hex `0x7f000001`, octal, or short `127.1` form),
 *     since `getaddrinfo` would still resolve those to an address
 *
 * Returns `null` if the input is acceptable, or a stable error code if it is
 * rejected. Callers attach the code to a 400 response.
 *
 * Lives in core (not the admin surface) because both the admin controllers and
 * `SsoService` (OIDC discovery) rely on it; keeping it here avoids a
 * core -> admin import.
 *
 * NOTE: this is a SYNTACTIC check on the host as written. A hostname that
 * *resolves* to a private IP (DNS rebinding / split-horizon) passes here. For
 * the server-side fetch paths use {@link validateResolvedHostIsPublic}, which
 * also resolves DNS and classifies every returned address.
 */
export function validateExternalHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'url_required'
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return 'url_invalid'
  }
  if (u.protocol !== 'https:') return 'url_must_be_https'
  const host = stripBrackets(u.hostname.toLowerCase())

  // By-name denials first, so `0.0.0.0` reads as loopback (not reserved) and
  // the metadata hostnames are blocked even though they aren't IP literals.
  if (host === 'localhost' || host === '0.0.0.0') return 'url_blocks_loopback'
  if (host === 'metadata.google.internal' || host === 'metadata') return 'url_blocks_metadata'

  const literal = classifyIpLiteral(host)
  if (literal !== 'not-an-ip') return literal

  // Not a canonical IP literal. Reject hosts that are an ambiguous numeric IP
  // encoding (decimal / hex / octal / short form): every dot-separated label
  // is numeric, so `getaddrinfo` would still turn it into an address and the
  // range checks above would never have run.
  if (looksLikeNumericIp(host)) return 'url_ambiguous_host'

  return null
}

/**
 * Defense-in-depth on top of {@link validateExternalHttpsUrl}: run the
 * syntactic check, then resolve the hostname and reject if ANY resolved
 * address falls in a blocked range. This catches the common SSRF bypass where
 * an attacker-controlled name (`evil.example`) resolves to a private/metadata
 * IP (e.g. `169.254.169.254`).
 *
 * Residual risk: this does not pin the resolved IP for the subsequent fetch, so
 * a name that rebinds between this check and the actual connection can still
 * slip through (TOCTOU). Pair it with network-level egress controls for a hard
 * boundary. When resolution itself fails we return `null` (allow): the
 * syntactic guard already passed and the fetch will fail on its own; we don't
 * fail closed on a transient DNS hiccup.
 */
export async function validateResolvedHostIsPublic(value: unknown): Promise<string | null> {
  const staticError = validateExternalHttpsUrl(value)
  if (staticError) return staticError

  const host = stripBrackets(new URL(value as string).hostname.toLowerCase())
  // Literal IPs were already classified robustly by the syntactic check; if we
  // got here they are genuinely public, so there is nothing for DNS to add.
  if (isIP(host) !== 0) return null

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    return null
  }
  for (const { address } of addresses) {
    const err = classifyIpLiteral(address.toLowerCase())
    if (err !== 'not-an-ip' && err !== null) return err
  }
  return null
}

/**
 * A validated, pinned HTTPS target: the parsed URL plus the single resolved
 * address the caller must connect to. {@link safeFetch} pins this address for the
 * connection (custom `lookup`) while keeping the Host header and TLS SNI on the
 * original hostname, so a name that rebinds AFTER this check can never be
 * reached. This closes the DNS-rebinding TOCTOU window that
 * {@link validateResolvedHostIsPublic} only documents.
 */
export interface PinnedHttpsTarget {
  url: URL
  hostname: string
  address: string
  family: number
}

/**
 * Resolve `value` to ONE validated public address for a pinned HTTPS fetch.
 * Runs the syntactic guard, then (for a hostname) resolves DNS exactly once and
 * rejects if ANY resolved address falls in a blocked range. Returns the first
 * address to pin, or a stable error code string.
 *
 * Fail-closed by construction: a syntactic rejection, a blocked address, or a
 * DNS-resolution failure all return an error code (no address), so the caller
 * never connects on a name it could not fully validate. The single resolution is
 * the one the connection pins, so there is no second lookup to rebind between.
 */
export async function resolvePinnedHttpsTarget(
  value: unknown
): Promise<PinnedHttpsTarget | string> {
  const staticError = validateExternalHttpsUrl(value)
  if (staticError) return staticError

  const url = new URL(value as string)
  const hostname = stripBrackets(url.hostname.toLowerCase())

  // A literal IP already passed the robust syntactic classification above; pin it.
  const fam = isIP(hostname)
  if (fam !== 0) return { url, hostname: url.hostname, address: hostname, family: fam }

  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(hostname, { all: true })
  } catch {
    return 'url_dns_failure' // cannot pin what we cannot resolve: fail closed
  }
  for (const a of addresses) {
    const err = classifyIpLiteral(a.address.toLowerCase())
    if (err !== 'not-an-ip' && err !== null) return err // a blocked address among the records
  }
  const target = addresses[0]
  if (!target) return 'url_dns_failure'
  return { url, hostname: url.hostname, address: target.address, family: target.family }
}

/**
 * True iff `value` is a syntactic loopback URL (localhost / 127.0.0.0/8 / ::1 /
 * an IPv4-mapped IPv6 loopback). Scopes the webhook delivery escape hatch: even
 * when an operator opts into delivering to otherwise-blocked targets, only
 * loopback is exempted — private (RFC 1918) and cloud-metadata ranges stay
 * blocked. A hostname that merely *resolves* to loopback is NOT matched here (it
 * still fails the resolving guard), so the exemption can't be abused via DNS
 * rebinding.
 */
export function isLoopbackUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return false
  }
  const host = stripBrackets(u.hostname.toLowerCase())
  if (host === 'localhost') return true
  return classifyIpLiteral(host) === 'url_blocks_loopback'
}

function stripBrackets(host: string): string {
  // Node's URL parser keeps the brackets on IPv6 literal hostnames
  // (`new URL('https://[::1]/').hostname === '[::1]'`), so strip them before
  // comparing — otherwise `[::1]`, `[fc00::1]`, `[fe80::1]` slip through the
  // IPv6 checks as opaque hostnames and the SSRF guard is bypassed.
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/**
 * Classify a host that is a canonical IP literal (IPv4, IPv6, or IPv4-mapped
 * IPv6 in any notation) against the blocked ranges. Returns a stable error
 * code when blocked, `null` when it is a normal public address, or the sentinel
 * `'not-an-ip'` when the host is not a canonical IP literal at all (a hostname).
 * `net.isIP` does the canonicalisation, so `::ffff:7f00:1`, `::ffff:127.0.0.1`,
 * and `127.0.0.1` all classify identically.
 */
function classifyIpLiteral(host: string): string | null | 'not-an-ip' {
  const fam = isIP(host)
  if (fam === 4) return classifyIpv4(host)
  if (fam === 6) return classifyIpv6(host)
  return 'not-an-ip'
}

function classifyIpv4(host: string): string | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  // host is already a valid IPv4 per net.isIP, so the match always succeeds.
  if (!m) return 'url_invalid_ipv4'
  return classifyIpv4Octets([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])])
}

// Only the first two octets decide every range we block; the full quad is
// passed so future ranges (e.g. a /24) can extend this without a signature
// change.
function classifyIpv4Octets(octets: readonly number[]): string | null {
  const [a, b] = octets
  if (a === 127) return 'url_blocks_loopback'
  if (a === 10) return 'url_blocks_private'
  if (a === 169 && b === 254) return 'url_blocks_link_local' // includes 169.254.169.254 (AWS metadata)
  if (a === 172 && b >= 16 && b <= 31) return 'url_blocks_private'
  if (a === 192 && b === 168) return 'url_blocks_private'
  if (a === 100 && b >= 64 && b <= 127) return 'url_blocks_cgn'
  if (a === 0) return 'url_blocks_reserved'
  if (a >= 224) return 'url_blocks_reserved' // 224/4 multicast, 240/4 reserved, 255.255.255.255 broadcast
  return null
}

function classifyIpv6(host: string): string | null {
  const h = ipv6Hextets(host)
  if (!h) return 'url_invalid_ipv6' // unreachable: net.isIP already validated it
  // ::1 loopback
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return 'url_blocks_loopback'
  // :: unspecified
  if (h.every((x) => x === 0)) return 'url_blocks_reserved'
  // IPv4-mapped (::ffff:0:0/96) and the deprecated IPv4-compatible (::a.b.c.d):
  // classify the embedded v4 so a mapped private/loopback address can't slip
  // through in hex (::ffff:7f00:1) or dotted (::ffff:127.0.0.1) form.
  const firstFiveZero = h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0
  if (firstFiveZero && h[5] === 0xffff) return classifyEmbeddedV4(h[6], h[7])
  if (firstFiveZero && h[5] === 0 && (h[6] !== 0 || h[7] !== 0))
    return classifyEmbeddedV4(h[6], h[7])
  // ULA fc00::/7
  if (h[0] >= 0xfc00 && h[0] <= 0xfdff) return 'url_blocks_private'
  // link-local fe80::/10 (fe80..febf)
  if (h[0] >= 0xfe80 && h[0] <= 0xfebf) return 'url_blocks_link_local'
  // IPv6 transition prefixes embed an IPv4 the host's NAT64/6to4/Teredo gateway
  // routes to, including private (RFC 1918) and cloud-metadata (169.254.x)
  // addresses that would otherwise bypass the IPv4 blocklist. On an IPv6-only
  // egress with NAT64 (standard on AWS/GCP/Azure), `64:ff9b::a9fe:a9fe` reaches
  // 169.254.169.254. A real webhook or OIDC target uses the public IPv4 or
  // hostname directly, so deny the whole transition space rather than trust the
  // embedded address.
  if (isTransitionV6(h)) return 'url_blocks_reserved'
  return null
}

/**
 * True for an IPv6 transition-address prefix that tunnels an IPv4 destination:
 * NAT64 well-known `64:ff9b::/96`, 6to4 `2002::/16`, or Teredo `2001:0000::/32`.
 */
function isTransitionV6(h: readonly number[]): boolean {
  // NAT64 well-known prefix 64:ff9b::/96 (last 32 bits carry the IPv4).
  if (h[0] === 0x0064 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return true
  }
  // 6to4 2002::/16 (IPv4 in h[1]:h[2]).
  if (h[0] === 0x2002) return true
  // Teredo 2001:0000::/32.
  if (h[0] === 0x2001 && h[1] === 0x0000) return true
  return false
}

function classifyEmbeddedV4(h6: number, h7: number): string | null {
  return classifyIpv4Octets([(h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff])
}

/**
 * Expand a (net.isIP-valid) IPv6 literal into its 8 numeric hextets, folding a
 * trailing dotted-v4 tail (`::ffff:1.2.3.4`) into two hextets. Returns null on
 * anything malformed, but callers only invoke this after `net.isIP === 6`.
 */
function ipv6Hextets(host: string): number[] | null {
  let s = host
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  const v4 = tail.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const o = [Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4])]
    if (o.some((n) => n > 255)) return null
    const h7 = ((o[0] << 8) | o[1]).toString(16)
    const h8 = ((o[2] << 8) | o[3]).toString(16)
    s = `${s.slice(0, lastColon + 1)}${h7}:${h8}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  let hextets: string[]
  if (halves.length === 2) {
    const back = halves[1] ? halves[1].split(':') : []
    const missing = 8 - head.length - back.length
    if (missing < 0) return null
    hextets = [...head, ...Array<string>(missing).fill('0'), ...back]
  } else {
    hextets = head
  }
  if (hextets.length !== 8) return null
  const nums = hextets.map((x) => (x === '' ? 0 : Number.parseInt(x, 16)))
  if (nums.some((n) => Number.isNaN(n) || n < 0 || n > 0xffff)) return null
  return nums
}

/**
 * True when every dot-separated label of `host` is purely numeric (decimal or
 * `0x`-hex), i.e. the host is an ambiguous numeric IP encoding rather than a
 * real hostname. `getaddrinfo` would still resolve `2130706433`, `0x7f000001`,
 * `0177.0.0.1`, and `127.1` to an address, so we reject them up front.
 */
function looksLikeNumericIp(host: string): boolean {
  if (host.length === 0) return false
  return host.split('.').every((label) => /^(0x[0-9a-f]+|\d+)$/i.test(label))
}
