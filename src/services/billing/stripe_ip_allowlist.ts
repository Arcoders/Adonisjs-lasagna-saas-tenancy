import { BlockList, isIPv4, isIPv6 } from 'node:net'
import { getConfig } from '../../config.js'

/**
 * IP allowlist check for `/webhooks/stripe`. Defence-in-depth on top of
 * HMAC signature verification — useful in environments where the secret
 * could be exposed (multi-team monorepos, leaked .env in CI).
 *
 * Supports BOTH literal IPs and CIDR ranges. Stripe's published webhook
 * range list (`https://stripe.com/files/ips/ips_webhooks.json`) ships
 * CIDR notation, so literal-only matching would silently reject every
 * webhook on a correctly-configured allowlist.
 *
 * Backed by `node:net.BlockList` (Node ≥18) — zero deps, native CIDR
 * support, IPv4 + IPv6, IPv4-mapped IPv6 normalisation handled by the
 * runtime.
 */

interface CompiledAllowlist {
  source: string[]
  blocks: BlockList
}

let _cached: CompiledAllowlist | null = null

/** @internal — for tests only. */
export function __resetIpAllowlistCache(): void {
  _cached = null
}

function compile(entries: ReadonlyArray<string>): CompiledAllowlist {
  const blocks = new BlockList()
  for (const raw of entries) {
    const entry = raw.trim()
    if (!entry) continue
    const slashIdx = entry.indexOf('/')
    try {
      if (slashIdx >= 0) {
        // CIDR form. addSubnet validates both the address and prefix; if
        // either is malformed it throws, which we swallow — invalid
        // entries are simply ignored rather than aborting the boot.
        // Operators audit the allowlist via `tenant:billing:doctor`.
        const addr = entry.slice(0, slashIdx)
        const prefix = Number.parseInt(entry.slice(slashIdx + 1), 10)
        const family = isIPv6(addr) ? 'ipv6' : isIPv4(addr) ? 'ipv4' : null
        if (family && Number.isFinite(prefix)) {
          blocks.addSubnet(addr, prefix, family)
        }
      } else {
        const family = isIPv6(entry) ? 'ipv6' : isIPv4(entry) ? 'ipv4' : null
        if (family) blocks.addAddress(entry, family)
      }
    } catch {
      // Best-effort skip on malformed entries.
    }
  }
  return { source: [...entries], blocks }
}

function getAllowlist(entries: ReadonlyArray<string>): CompiledAllowlist {
  if (_cached && _cached.source.length === entries.length) {
    let same = true
    for (let i = 0; i < entries.length; i++) {
      if (_cached.source[i] !== entries[i]) {
        same = false
        break
      }
    }
    if (same) return _cached
  }
  _cached = compile(entries)
  return _cached
}

export function isStripeWebhookOriginAllowed(
  remoteIp: string | undefined
): boolean {
  const cfg = getConfig().billing
  if (!cfg?.webhook?.enforceIpAllowlist) return true
  if (!remoteIp) return false

  const list = cfg.webhook.allowedIps ?? []
  if (list.length === 0) return false

  const compiled = getAllowlist(list)
  // BlockList.check accepts both literals and 4-mapped-6 forms; node
  // normalises ::ffff:1.2.3.4 internally when checking against IPv4 entries.
  const family = isIPv6(remoteIp) ? 'ipv6' : isIPv4(remoteIp) ? 'ipv4' : null
  if (!family) {
    // Strip ::ffff: prefix for v4-mapped form before bailing on validation.
    const normalised = remoteIp.replace(/^::ffff:/i, '')
    if (isIPv4(normalised)) {
      return compiled.blocks.check(normalised, 'ipv4')
    }
    return false
  }
  return compiled.blocks.check(remoteIp, family)
}

