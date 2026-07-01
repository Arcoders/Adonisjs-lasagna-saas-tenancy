import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'
import { isLoopbackUrl, resolvePinnedHttpsTarget } from './url.js'

/**
 * The single hardened seam for outbound HTTP the package makes to destinations it
 * does not fully control (webhook delivery, OIDC token/discovery) or to a small
 * set of first-party API hosts (billing). Routing every outbound call through
 * here means the SSRF posture is enforced in one place, and a static guard
 * (`@architecture/boundaries/no_raw_outbound_fetch.spec.ts`) keeps new code from
 * reaching the network any other way.
 *
 * Two modes:
 *
 *  - PINNED (default). For attacker-influenced destinations. Resolve + validate
 *    the host ONCE, then connect to that exact validated address while presenting
 *    the original hostname for the Host header and TLS SNI. A name that rebinds
 *    to a private/metadata address after the check can never be reached, which
 *    closes the DNS-rebinding TOCTOU window. Redirects are never followed (a 3xx
 *    is returned for the caller to treat as terminal). Resolution failure fails
 *    closed.
 *  - TRUSTED-HOST (`trustedHost: true`). For first-party static API hosts that
 *    sit behind a CDN/edge (billing). Pinning a rotating CDN address would break
 *    payments, so these are deliberately NOT pinned. We assert the host is HTTPS
 *    and on the single-sourced allowlist, still refuse to follow redirects, and
 *    share the timeout handling, so they gain the guard without the pin.
 */

/** First-party static API hosts that route through safeFetch WITHOUT pinning. */
export const TRUSTED_FETCH_HOSTS: ReadonlySet<string> = new Set([
  'api.paddle.com',
  'sandbox-api.paddle.com',
  'api.lemonsqueezy.com',
])

export interface SafeFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | URLSearchParams
  /** Abort the request after this many ms (maps to the socket timeout / fetch signal). */
  timeoutMs?: number
  /** Caller-supplied abort signal (composed with timeoutMs). */
  signal?: AbortSignal
  /** Route to a first-party trusted host WITHOUT pinning (billing API hosts). */
  trustedHost?: boolean
  /**
   * Permit a loopback target without pinning (in-process test/dev listeners).
   * Only loopback is exempted; private (RFC 1918) and cloud-metadata ranges stay
   * blocked because a non-loopback host still goes through the pinned validation.
   */
  allowLoopback?: boolean
}

/**
 * Thrown when safeFetch refuses to make a request. `retryable` distinguishes a
 * transient resolution/timeout failure (the caller may retry, each attempt
 * re-validates) from a structural/security rejection (a blocked range, non-HTTPS,
 * an off-allowlist host) that will never succeed and must not be retried.
 */
export class SafeFetchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false
  ) {
    super(message)
    this.name = 'SafeFetchError'
  }
}

// Statuses that forbid a response body (RFC 9110): constructing a Response with a
// body for these throws, so we pass null instead.
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])

/** origin + pathname only, so a query string carrying a token never lands in an error/log. */
function redactUrl(value: string): string {
  try {
    const u = new URL(value)
    return `${u.origin}${u.pathname}`
  } catch {
    return '[unparseable url]'
  }
}

function normalizeBody(body: SafeFetchOptions['body']): string | undefined {
  if (body === undefined) return undefined
  if (body instanceof URLSearchParams) return body.toString()
  return body
}

/**
 * A custom DNS `lookup` that pins every connection attempt to one
 * already-validated address, so no second resolution can rebind the hostname to
 * a private/metadata target (the DNS-rebinding TOCTOU guard). The hostname
 * argument is ignored — there is no real lookup, only the pin.
 *
 * It must honour Node's Happy-Eyeballs contract: since Node 20, `autoSelectFamily`
 * (default true) invokes a custom lookup with `{ all: true }` and REQUIRES an
 * array result `[{ address, family }]`. A single-address callback there throws
 * `ERR_INVALID_IP_ADDRESS` at connect time, which silently broke every pinned
 * request on Node 24 (webhook delivery, OIDC token/discovery) — the failure was
 * wrapped as a retryable `network_error`, so it read as flaky networking rather
 * than a hard bug. We return the pinned address in whichever shape the caller
 * asked for. Either way it is the same single validated address, so the pin holds.
 */
export function pinnedLookup(address: string, family: number): LookupFunction {
  return ((_hostname, options, callback) => {
    if (options && (options as { all?: boolean }).all) {
      ;(callback as (err: null, addresses: Array<{ address: string; family: number }>) => void)(
        null,
        [{ address, family }]
      )
    } else {
      ;(callback as (err: null, address: string, family: number) => void)(null, address, family)
    }
  }) as LookupFunction
}

function combinedSignal(opts: SafeFetchOptions): AbortSignal | undefined {
  if (opts.signal && opts.timeoutMs) {
    return AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs)])
  }
  if (opts.signal) return opts.signal
  if (opts.timeoutMs) return AbortSignal.timeout(opts.timeoutMs)
  return undefined
}

export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<Response> {
  if (opts.trustedHost) return trustedHostFetch(url, opts)
  if (opts.allowLoopback && isLoopbackUrl(url)) return loopbackFetch(url, opts)
  return pinnedFetch(url, opts)
}

async function trustedHostFetch(url: string, opts: SafeFetchOptions): Promise<Response> {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new SafeFetchError('url_invalid', `safeFetch: invalid url ${redactUrl(url)}`)
  }
  if (u.protocol !== 'https:') {
    throw new SafeFetchError(
      'url_must_be_https',
      `safeFetch: trusted host must be https (${u.protocol})`
    )
  }
  if (!TRUSTED_FETCH_HOSTS.has(u.hostname.toLowerCase())) {
    throw new SafeFetchError(
      'host_not_trusted',
      `safeFetch: ${u.hostname} is not in the trusted-host allowlist`
    )
  }
  // Not pinned (CDN/edge rotation must keep working), but still no auto-redirect
  // and a shared timeout. body is normalized so URLSearchParams works uniformly.
  // safe-fetch-ok: the one trusted-host fetch, host allowlisted + https-asserted above.
  return fetch(url, {
    method: opts.method,
    headers: opts.headers,
    body: normalizeBody(opts.body),
    redirect: 'manual',
    signal: combinedSignal(opts),
  })
}

async function loopbackFetch(url: string, opts: SafeFetchOptions): Promise<Response> {
  // Explicit loopback escape hatch (test/dev in-process listeners). The target is
  // a trusted local listener, not an attacker-influenced host, so it is not
  // pinned. safe-fetch-ok: loopback opt-in, gated by the caller's policy flag.
  return fetch(url, {
    method: opts.method,
    headers: opts.headers,
    body: normalizeBody(opts.body),
    redirect: 'manual',
    signal: combinedSignal(opts),
  })
}

async function pinnedFetch(url: string, opts: SafeFetchOptions): Promise<Response> {
  const target = await resolvePinnedHttpsTarget(url)
  if (typeof target === 'string') {
    // url_dns_failure is transient (retry re-validates); everything else is a
    // structural/security rejection that must not be retried.
    const retryable = target === 'url_dns_failure'
    throw new SafeFetchError(
      target,
      `safeFetch: refusing to fetch ${redactUrl(url)} (${target})`,
      retryable
    )
  }

  const { url: u, hostname, address, family } = target
  const headers: Record<string, string> = {
    // Disable compression so we never have to decompress to read the body: these
    // endpoints honor identity and the responses are small JSON/text.
    'accept-encoding': 'identity',
    ...(opts.headers ?? {}),
    'host': hostname,
  }
  const body = normalizeBody(opts.body)
  const signal = combinedSignal(opts)

  return new Promise<Response>((resolve, reject) => {
    const req = httpsRequest(
      {
        host: hostname,
        servername: hostname, // SNI + cert validation against the real hostname
        port: u.port ? Number(u.port) : 443,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? 'GET',
        headers,
        // PIN: every connection resolves to the single validated address. The
        // hostname argument is ignored, so there is no second DNS lookup to
        // rebind. Honours Node's Happy-Eyeballs `{ all }` contract (see pinnedLookup).
        lookup: pinnedLookup(address, family),
        signal,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const status = res.statusCode ?? 502
          const outHeaders = new Headers()
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') outHeaders.set(k, v)
            else if (Array.isArray(v)) outHeaders.set(k, v.join(', '))
          }
          const payload =
            NULL_BODY_STATUS.has(status) || chunks.length === 0 ? null : Buffer.concat(chunks)
          // A 3xx is returned as-is; pinned mode never follows a redirect, so the
          // caller decides (every caller treats a 3xx as a terminal failure).
          resolve(new Response(payload, { status, headers: outHeaders }))
        })
        res.on('error', reject)
      }
    )
    req.on('error', (err) => {
      reject(
        new SafeFetchError('network_error', `safeFetch: ${redactUrl(url)} ${err.message}`, true)
      )
    })
    if (body !== undefined) req.write(body)
    req.end()
  })
}
