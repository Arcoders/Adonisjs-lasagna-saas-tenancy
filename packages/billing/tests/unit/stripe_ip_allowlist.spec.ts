import { test } from '@japa/runner'
import { setConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import {
  isStripeWebhookOriginAllowed,
  __resetIpAllowlistCache,
} from '../../src/services/billing/stripe_ip_allowlist.js'

/**
 * Helper-level coverage for IP allowlist matching. Lives under unit/
 * because it asserts the pure helper without spinning up the integration
 * fixture; mixing src imports with the booted-provider config singleton
 * causes a dual-module hazard where `setConfig` from the package writes
 * to a different `_config` than the helper's src copy reads from.
 *
 * The middleware integration counterpart (which exercises the helper
 * end-to-end through `VerifyStripeWebhookMiddleware.handle`) lives in
 * `tests/integration/billing/ip_allowlist.spec.ts`. Together they cover
 * Layer 1 (matching correctness) and Layer 2 (middleware actually
 * invokes the helper before signature verification).
 */
test.group('stripe_ip_allowlist — CIDR/IPv6/literal/malformed', (group) => {
  group.each.setup(() => {
    __resetIpAllowlistCache()
  })

  function withAllowlist(allowedIps: string[]): void {
    setConfig({
      billing: {
        driver: 'stripe',
        stripe: { apiKey: 'sk_test_x', webhookSecret: 'whsec_test' },
        products: { prod_starter: 'starter' },
        defaultPlan: 'starter',
        webhook: { enforceIpAllowlist: true, allowedIps },
      },
    } as never)
    __resetIpAllowlistCache()
  }

  test('off by default: every IP allowed when enforce flag is unset', ({ assert }) => {
    setConfig({
      billing: {
        driver: 'stripe',
        stripe: { apiKey: 'sk_test_x', webhookSecret: 'whsec_test' },
        products: { prod_starter: 'starter' },
        defaultPlan: 'starter',
      },
    } as never)
    assert.isTrue(isStripeWebhookOriginAllowed('1.2.3.4'))
    assert.isTrue(isStripeWebhookOriginAllowed(undefined))
    assert.isTrue(isStripeWebhookOriginAllowed('::1'))
  })

  test('literal IPv4 match', ({ assert }) => {
    withAllowlist(['54.187.174.169', '54.187.205.235'])
    assert.isTrue(isStripeWebhookOriginAllowed('54.187.174.169'))
    assert.isTrue(isStripeWebhookOriginAllowed('54.187.205.235'))
    assert.isFalse(isStripeWebhookOriginAllowed('54.187.174.170'))
  })

  test('CIDR /24 — IP inside range matches, outside does not', ({ assert }) => {
    withAllowlist(['54.187.174.0/24'])
    assert.isTrue(isStripeWebhookOriginAllowed('54.187.174.1'))
    assert.isTrue(isStripeWebhookOriginAllowed('54.187.174.255'))
    assert.isFalse(isStripeWebhookOriginAllowed('54.187.175.0'))
  })

  test('mixed literal + CIDR list', ({ assert }) => {
    withAllowlist(['10.0.0.5', '192.168.0.0/16'])
    assert.isTrue(isStripeWebhookOriginAllowed('10.0.0.5'))
    assert.isTrue(isStripeWebhookOriginAllowed('192.168.42.42'))
    assert.isFalse(isStripeWebhookOriginAllowed('10.0.0.6'))
    assert.isFalse(isStripeWebhookOriginAllowed('172.16.0.1'))
  })

  test('IPv4-mapped IPv6 normalised then matched against IPv4 entry', ({ assert }) => {
    withAllowlist(['54.187.174.169'])
    assert.isTrue(isStripeWebhookOriginAllowed('::ffff:54.187.174.169'))
  })

  test('malformed IP rejected without throwing', ({ assert }) => {
    withAllowlist(['10.0.0.1'])
    assert.isFalse(isStripeWebhookOriginAllowed('not-an-ip'))
    assert.isFalse(isStripeWebhookOriginAllowed(''))
  })

  test('empty allowedIps with enforce on rejects everything (fail-closed)', ({ assert }) => {
    withAllowlist([])
    assert.isFalse(isStripeWebhookOriginAllowed('10.0.0.1'))
    assert.isFalse(isStripeWebhookOriginAllowed(undefined))
  })
})
