import { test } from '@japa/runner'
import { WebhookService } from '@adonisjs-lasagna/saas-tenancy/services'
import { makeDelivery, makeHook } from '../../../helpers/webhook_doubles.js'

process.env.APP_KEY = process.env.APP_KEY ?? 'test-app-key-for-webhooks-tests!'

/**
 * Service-level SSRF matrix for webhook delivery. The unit suite proves the
 * URL guard classifies every encoding (tests/unit/utils/url.spec.ts); this
 * spec proves `WebhookService.send()` actually consults the guard for each
 * of those encodings — a persisted URL in ANY blocked notation must mark
 * the delivery permanently failed without a single fetch. Guards the
 * security.md/webhooks.md SSRF promise at the boundary attackers reach.
 */

const BLOCKED_TARGETS: Array<[label: string, url: string]> = [
  ['hex-octet IPv4 (metadata IP)', 'https://0xa9.0xfe.0xa9.0xfe/'],
  ['decimal-integer IPv4 (metadata IP)', 'https://2852039166/'],
  ['octal IPv4 (loopback)', 'https://0177.0.0.1/'],
  ['short-form IPv4 (loopback)', 'https://127.1/'],
  ['IPv4-mapped IPv6, dotted (metadata IP)', 'https://[::ffff:169.254.169.254]/'],
  ['IPv4-mapped IPv6, hex (loopback)', 'https://[::ffff:7f00:1]/'],
  ['plain IPv6 loopback', 'https://[::1]/'],
  ['IPv6 ULA (private)', 'https://[fd00::1]/'],
  ['RFC 1918 private', 'https://10.0.0.1/'],
  ['link-local / metadata', 'https://169.254.169.254/latest/meta-data/'],
  ['non-https scheme', 'http://example.com/webhook'],
]

test.group('WebhookService.send() — SSRF encoding matrix', (group) => {
  let originalFetch: typeof globalThis.fetch
  const svc = new WebhookService()

  group.each.setup(() => {
    originalFetch = globalThis.fetch
  })

  group.each.teardown(() => {
    globalThis.fetch = originalFetch
  })

  for (const [label, url] of BLOCKED_TARGETS) {
    test(`blocks ${label} — ${url}`, async ({ assert }) => {
      let fetchCalled = false
      globalThis.fetch = (async () => {
        fetchCalled = true
        return { ok: true, status: 200, text: async () => '{}' }
      }) as unknown as typeof fetch

      const delivery = makeDelivery()
      await svc.send(makeHook({ url }) as any, delivery as any)

      assert.isFalse(fetchCalled, `fetch must never run for ${url}`)
      assert.equal(delivery.status, 'failed')
      assert.match(String(delivery.responseBody), /blocked_unsafe_url/)
      // Permanently failed: no retry sweep may pick it up — retrying an
      // unsafe target would just re-attempt the SSRF.
      assert.isNull(delivery.nextRetryAt)
    })
  }

  // SECURITY (#8): the URL guard validated the front door, but a 3xx Location is
  // chosen by the (attacker-influenced) receiver and the guard never sees it.
  // send() must pin redirect:'manual' and treat a 3xx as a permanent failure,
  // never following it to an internal/metadata host.
  test('does not follow a 3xx redirect from a validated target', async ({ assert }) => {
    let fetchCount = 0
    let usedManualRedirect = false
    globalThis.fetch = (async (_url: unknown, init: any) => {
      fetchCount++
      if (init?.redirect === 'manual') usedManualRedirect = true
      return {
        ok: false,
        status: 302,
        headers: { get: () => 'http://169.254.169.254/' },
        text: async () => '',
      }
    }) as unknown as typeof fetch

    const delivery = makeDelivery()
    await svc.send(makeHook({ url: 'https://example.com/webhook' }) as any, delivery as any)

    assert.isTrue(usedManualRedirect, "send() must request redirect:'manual'")
    assert.equal(fetchCount, 1, 'the redirect must NOT be followed (single fetch)')
    assert.equal(delivery.status, 'failed')
    assert.match(String(delivery.responseBody), /blocked_redirect:302/)
    assert.isNull(delivery.nextRetryAt, 'a redirect is a permanent, non-retryable failure')
  })

  test('the matrix is not fail-everything: a public https url still delivers', async ({
    assert,
  }) => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      text: async () => '{}',
    })) as unknown as typeof fetch

    const delivery = makeDelivery()
    await svc.send(makeHook({ url: 'https://example.com/webhook' }) as any, delivery as any)

    assert.equal(delivery.status, 'success')
  })
})
