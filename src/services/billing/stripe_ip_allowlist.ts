import { getConfig } from '../../config.js'
import { isIPv4, isIPv6 } from 'node:net'

/**
 * IP allowlist check for `/webhooks/stripe`. Defence-in-depth on top of
 * HMAC signature verification — useful in environments where the secret
 * could be exposed (multi-team monorepos, leaked .env in CI).
 *
 * v1 only honours the literal `config.billing.webhook.allowedIps` list
 * (CIDR not yet supported — exact-match only). Auto-fetching Stripe's
 * published ranges (`https://stripe.com/files/ips/ips_webhooks.json`)
 * with BentoCache 24h TTL is reserved for v1.1 to avoid an extra HTTP
 * dependency at boot.
 */
export function isStripeWebhookOriginAllowed(
  remoteIp: string | undefined
): boolean {
  const cfg = getConfig().billing
  if (!cfg?.webhook?.enforceIpAllowlist) return true
  if (!remoteIp) return false

  // Normalise — Node returns ::ffff:1.2.3.4 for IPv4-mapped IPv6.
  const normalised = remoteIp.replace(/^::ffff:/, '')
  if (!isIPv4(normalised) && !isIPv6(normalised)) return false

  const list = cfg.webhook.allowedIps ?? []
  if (list.length === 0) return false
  return list.some((entry) => entry === normalised || entry === remoteIp)
}
