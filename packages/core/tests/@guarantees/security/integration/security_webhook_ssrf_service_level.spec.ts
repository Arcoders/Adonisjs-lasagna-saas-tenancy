import { test } from '@japa/runner'
import { WebhookService } from '@adonisjs-lasagna/saas-tenancy/services'
import type { SafeFetchOptions } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import { makeDelivery, makeHook } from '../../../helpers/webhook_doubles.js'

process.env.APP_KEY = process.env.APP_KEY ?? 'test-app-key-for-webhooks-tests!'

/**
 * Service-level SSRF matrix for webhook delivery. The unit suite proves the
 * URL guard classifies every encoding (tests/unit/utils/url.spec.ts); this
 * spec proves `WebhookService.send()` actually consults the guard for each
 * of those encodings: a persisted URL in ANY blocked notation must mark
 * the delivery permanently failed without delivering. The block lives inside
 * the real transport (safeFetch), so these run against the production default,
 * not an injected double. Guards the security.md/webhooks.md SSRF promise at the
 * boundary attackers reach.
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

test.group('WebhookService.send() — SSRF encoding matrix', () => {
  // The real default transport (safeFetch) enforces the SSRF block, so each case
  // runs against it. A blocked target must fail closed before any byte leaves.
  const svc = new WebhookService()

  for (const [label, url] of BLOCKED_TARGETS) {
    test(`blocks ${label} — ${url}`, async ({ assert }) => {
      const delivery = makeDelivery()
      await svc.send(makeHook({ url }) as any, delivery as any)

      assert.equal(delivery.status, 'failed')
      assert.match(String(delivery.responseBody), /blocked_unsafe_url/)
      // Permanently failed: no retry sweep may pick it up, since retrying an
      // unsafe target would just re-attempt the SSRF.
      assert.isNull(delivery.nextRetryAt)
    })
  }

  // SECURITY (#8): the URL guard validated the front door, but a 3xx Location is
  // chosen by the (attacker-influenced) receiver and the guard never sees it.
  // safeFetch never follows a redirect (the pinned transport surfaces the 3xx
  // itself), and send() must treat a 3xx as a permanent failure, never following
  // it to an internal/metadata host. The double returns a 302 to assert exactly
  // that classification (a single attempt, no follow).
  test('does not follow a 3xx redirect from a validated target', async ({ assert }) => {
    let calls = 0
    const transport = async (_url: string, _opts: SafeFetchOptions): Promise<Response> => {
      calls++
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
    }
    const svc302 = new WebhookService({ transport })

    const delivery = makeDelivery()
    await svc302.send(makeHook({ url: 'https://example.com/webhook' }) as any, delivery as any)

    assert.equal(calls, 1, 'send() makes one transport call and classifies the 3xx itself')
    assert.equal(delivery.status, 'failed')
    assert.match(String(delivery.responseBody), /blocked_redirect:302/)
    assert.isNull(delivery.nextRetryAt, 'a redirect is a permanent, non-retryable failure')
  })

  test('the matrix is not fail-everything: a public https url still delivers', async ({
    assert,
  }) => {
    const transport = async (_url: string, _opts: SafeFetchOptions): Promise<Response> =>
      new Response('{}', { status: 200 })
    const svcOk = new WebhookService({ transport })

    const delivery = makeDelivery()
    await svcOk.send(makeHook({ url: 'https://example.com/webhook' }) as any, delivery as any)

    assert.equal(delivery.status, 'success')
  })
})
