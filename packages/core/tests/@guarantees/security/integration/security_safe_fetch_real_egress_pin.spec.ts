import { test } from '@japa/runner'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { safeFetch, SafeFetchError } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'

/**
 * GATING real-egress SSRF pin. The DNS-pinned outbound seam (`safeFetch`) is the
 * single choke point every first-party egress goes through (webhooks, SSO token
 * exchange, crypto KeyProvider). Its SSRF guarantee was previously proven against a
 * REAL socket ONLY in the fault-injection/chaos tier (`@integration/fault_injection/
 * safe_fetch_pinning.spec.ts`), which runs only on a `[chaos]`-tagged commit with
 * `continue-on-error: true`, so on an ordinary run the ONLY SSRF coverage was a
 * monkeypatched-`fetch` double. That let a real-egress regression ship green.
 *
 * This spec lives in the GATING security-integration tier (it runs on every
 * integration CI run), and it drives a REAL in-process listener on 127.0.0.1 (no
 * `fetch` double) to pin the load-bearing property end to end:
 *   - pinned mode (the default) REFUSES a loopback target before any byte leaves
 *     (SafeFetchError, non-retryable): a hostname that resolves to a private/loopback
 *     address can never be reached without an explicit opt-in;
 *   - `allowLoopback` reaches the real listener and returns a usable Response, so the
 *     pin resolves to exactly the validated address (no false block of the opt-in).
 */
test.group('security: safeFetch real-egress SSRF pin (gating)', (group) => {
  let server: Server
  let url: string

  group.setup(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, method: req.method }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    url = `http://127.0.0.1:${port}/hook`
  })

  group.teardown(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    )
  })

  test('pinned mode (default) REFUSES a real loopback target — fail-closed before egress', async ({
    assert,
  }) => {
    // 127.0.0.1 is a blocked range and https is required, so this fails closed
    // before any connection is attempted. This is the SSRF guarantee against a real socket.
    try {
      await safeFetch(url, { method: 'POST', body: '{}' })
      assert.fail('pinned mode must refuse a real loopback target')
    } catch (err) {
      assert.instanceOf(err, SafeFetchError)
      assert.isFalse((err as SafeFetchError).retryable, 'an SSRF block is non-retryable')
    }
  })

  test('allowLoopback reaches the REAL in-process listener and returns a Response', async ({
    assert,
  }) => {
    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      allowLoopback: true,
    })
    assert.equal(res.status, 200, 'the explicit opt-in reaches the validated address')
    const json = (await res.json()) as { ok: boolean; method: string }
    assert.isTrue(json.ok)
    assert.equal(json.method, 'POST')
  })
})
