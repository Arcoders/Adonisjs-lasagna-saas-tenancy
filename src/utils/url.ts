import { lookup } from 'node:dns/promises'

/**
 * Reject URLs that would let a caller pivot the package's outbound fetcher
 * (webhook delivery, OIDC discovery) at internal infrastructure.
 *
 * Rules:
 *   - scheme MUST be `https:` (no http/file/gopher/ftp/data)
 *   - hostname MUST NOT resolve, syntactically, to loopback, link-local,
 *     RFC 1918 private ranges, or AWS/GCP metadata IPs
 *   - hostname MUST NOT be an IPv6 literal in `::1`/`fc00::/7`/`fe80::/10`
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
  if (host === 'localhost' || host === '0.0.0.0') return 'url_blocks_loopback'

  const ipError = classifyIp(host)
  if (ipError) return ipError

  // GCP metadata server hostname. Resolves to 169.254.169.254 but a crafty
  // caller could exploit DNS-rebinding-style tricks if we only checked
  // literals; deny by name as well.
  if (host === 'metadata.google.internal' || host === 'metadata') {
    return 'url_blocks_metadata'
  }

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
  // Literal IPs were already classified by the syntactic check.
  if (isIpLiteral(host)) return null

  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    return null
  }
  for (const { address } of addresses) {
    const err = classifyIp(address.toLowerCase())
    if (err) return err
  }
  return null
}

function stripBrackets(host: string): string {
  // Node's URL parser keeps the brackets on IPv6 literal hostnames
  // (`new URL('https://[::1]/').hostname === '[::1]'`), so strip them before
  // comparing — otherwise `[::1]`, `[fc00::1]`, `[fe80::1]` slip through the
  // IPv6 checks as opaque hostnames and the SSRF guard is bypassed.
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host.includes(':')
}

/**
 * Classify an IP literal (v4 or v6, or an IPv4-mapped v6) against the blocked
 * ranges. Returns a stable error code, or `null` when the address is a normal
 * public address. Shared by the syntactic check and the DNS-resolution check.
 */
function classifyIp(host: string): string | null {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const a = Number(v4[1])
    const b = Number(v4[2])
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n < 0 || n > 255)) {
      return 'url_invalid_ipv4'
    }
    if (a === 127) return 'url_blocks_loopback'
    if (a === 10) return 'url_blocks_private'
    if (a === 169 && b === 254) return 'url_blocks_link_local' // includes 169.254.169.254 (AWS metadata)
    if (a === 172 && b >= 16 && b <= 31) return 'url_blocks_private'
    if (a === 192 && b === 168) return 'url_blocks_private'
    if (a === 100 && b >= 64 && b <= 127) return 'url_blocks_cgn'
    if (a === 0) return 'url_blocks_reserved'
    return null
  }

  if (host.includes(':')) {
    if (host === '::1') return 'url_blocks_loopback'
    if (host === '::' || host === '::ffff:0:0') return 'url_blocks_reserved'
    // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) — classify the embedded v4 so a
    // mapped private address can't slip through.
    const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
    if (mapped) return classifyIp(mapped[1])
    if (host.startsWith('fc') || host.startsWith('fd')) return 'url_blocks_private'
    if (host.startsWith('fe80')) return 'url_blocks_link_local'
    return null
  }

  return null
}
