import { test } from '@japa/runner'
import { WebhookService } from '@adonisjs-lasagna/saas-tenancy/services'
import { makeDelivery, makeHook } from '../../../helpers/webhook_doubles.js'

process.env.APP_KEY = process.env.APP_KEY ?? 'test-app-key-for-webhooks-tests!'

/**
 * The WEBHOOKS_ALLOW_LOOPBACK_TARGETS escape hatch (webhook_service.ts:158-160).
 * Off by default the SSRF guard treats loopback like any other internal target
 * and refuses it (proven across every notation in
 * webhook_ssrf_service_level.spec.ts). This spec proves the opt-in narrows to
 * exactly what the docs promise: with the flag on, a *loopback* target delivers,
 * but private (RFC 1918), CGN and cloud-metadata ranges STAY blocked, so the
 * flag can never be escalated into a metadata SSRF. It also proves only the
 * exact string "true" opts in. Guards the security.md / quickstart claim and the
 * demo e2e job, which sets the flag to deliver to an in-process 127.0.0.1
 * listener.
 */
test.group('WebhookService.send() — WEBHOOKS_ALLOW_LOOPBACK_TARGETS opt-in', (group) => {
  let originalFetch: typeof globalThis.fetch
  let originalFlag: string | undefined
  const svc = new WebhookService()

  group.each.setup(() => {
    originalFetch = globalThis.fetch
    originalFlag = process.env.WEBHOOKS_ALLOW_LOOPBACK_TARGETS
  })

  group.each.teardown(() => {
    globalThis.fetch = originalFetch
    if (originalFlag === undefined) delete process.env.WEBHOOKS_ALLOW_LOOPBACK_TARGETS
    else process.env.WEBHOOKS_ALLOW_LOOPBACK_TARGETS = originalFlag
  })

  // Records whether the real network was ever touched. A blocked target must
  // never reach fetch (reaching it is the SSRF).
  function stubFetch(): () => boolean {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return { ok: true, status: 200, text: async () => '{}' }
    }) as unknown as typeof fetch
    return () => called
  }

  // --- flag ON: loopback (and only loopback) delivers ---

  const LOOPBACK_DELIVERS: Array<[label: string, url: string]> = [
    ['IPv4 loopback over http (the dev/e2e shape)', 'http://127.0.0.1:8787/hooks'],
    ['127.0.0.0/8, not just .1', 'http://127.9.9.9:8787/hooks'],
    ['localhost by name', 'http://localhost:8787/hooks'],
    ['IPv6 loopback ::1', 'http://[::1]:8787/hooks'],
    ['IPv4-mapped IPv6 loopback', 'http://[::ffff:127.0.0.1]:8787/hooks'],
  ]
  for (const [label, url] of LOOPBACK_DELIVERS) {
    test(`flag on: delivers to ${label} — ${url}`, async ({ assert }) => {
      process.env.WEBHOOKS_ALLOW_LOOPBACK_TARGETS = 'true'
      const fetched = stubFetch()

      const delivery = makeDelivery()
      await svc.send(makeHook({ url }) as any, delivery as any)

      assert.isTrue(fetched(), `the opt-in must let a loopback target deliver: ${url}`)
      assert.equal(delivery.status, 'success')
    })
  }

  // --- flag ON: private / CGN / metadata STAY blocked (the security half) ---

  const STILL_BLOCKED_UNDER_FLAG: Array<[label: string, url: string]> = [
    ['RFC 1918 10/8', 'https://10.0.0.1/hook'],
    ['RFC 1918 172.16/12', 'https://172.16.0.1/hook'],
    ['RFC 1918 192.168/16', 'https://192.168.1.1/hook'],
    ['carrier-grade NAT 100.64/10', 'https://100.64.0.1/hook'],
    ['cloud metadata 169.254.169.254', 'https://169.254.169.254/latest/meta-data/'],
    ['IPv4-mapped IPv6 metadata', 'https://[::ffff:169.254.169.254]/'],
    ['IPv6 ULA fd00::/8', 'https://[fd00::1]/'],
    ['0.0.0.0 is reserved, not loopback', 'https://0.0.0.0/hook'],
  ]
  for (const [label, url] of STILL_BLOCKED_UNDER_FLAG) {
    test(`flag on: STILL blocks ${label} — ${url}`, async ({ assert }) => {
      process.env.WEBHOOKS_ALLOW_LOOPBACK_TARGETS = 'true'
      const fetched = stubFetch()

      const delivery = makeDelivery()
      await svc.send(makeHook({ url }) as any, delivery as any)

      assert.isFalse(fetched(), `the flag exempts loopback only — ${url} must never reach fetch`)
      assert.equal(delivery.status, 'failed')
      assert.match(String(delivery.responseBody), /blocked_unsafe_url/)
      // Permanently failed: an unsafe target must not be requeued for a retry.
      assert.isNull(delivery.nextRetryAt)
    })
  }

  // --- default / wrong value: the exemption is strictly opt-in ---

  test('flag off (default): loopback is blocked like any internal target', async ({ assert }) => {
    delete process.env.WEBHOOKS_ALLOW_LOOPBACK_TARGETS
    const fetched = stubFetch()

    const delivery = makeDelivery()
    await svc.send(makeHook({ url: 'http://127.0.0.1:8787/hooks' }) as any, delivery as any)

    assert.isFalse(fetched(), 'without the opt-in, loopback must not deliver')
    assert.equal(delivery.status, 'failed')
    assert.match(String(delivery.responseBody), /blocked_unsafe_url/)
  })

  test('only the exact string "true" opts in (a truthy "1" does not)', async ({ assert }) => {
    process.env.WEBHOOKS_ALLOW_LOOPBACK_TARGETS = '1'
    const fetched = stubFetch()

    const delivery = makeDelivery()
    await svc.send(makeHook({ url: 'http://127.0.0.1:8787/hooks' }) as any, delivery as any)

    assert.isFalse(fetched(), 'only WEBHOOKS_ALLOW_LOOPBACK_TARGETS="true" enables the exemption')
    assert.equal(delivery.status, 'failed')
  })
})
