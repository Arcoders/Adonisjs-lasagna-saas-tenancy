import { test } from '@japa/runner'
import { createServer, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { safeFetch, SafeFetchError } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'

/**
 * Fault injection (WS-4): the pinned outbound seam never reaches a private/
 * loopback target by default, and the loopback escape hatch is an explicit
 * opt-in. We stand up a real in-process listener on 127.0.0.1 and assert:
 *
 *   - pinned mode (the default) REFUSES it (127.0.0.1 is a blocked range), so a
 *     name that resolves to loopback can never be connected without opting in;
 *   - allowLoopback reaches it and returns a usable Response.
 *
 * This is the load-bearing property: the seam connects only to addresses it has
 * validated, and a private-range target is never connected unless the caller
 * explicitly permits loopback.
 */
test.group('fault: safeFetch pinning + loopback boundary', (group) => {
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

  test('pinned mode (default) refuses a loopback target', async ({ assert }) => {
    // No allowLoopback: the loopback host is a blocked range. https is required
    // too, so this fails closed before any connection is attempted.
    try {
      await safeFetch(url, { method: 'POST', body: '{}' })
      assert.fail('pinned mode must refuse a loopback target')
    } catch (err) {
      assert.instanceOf(err, SafeFetchError)
      assert.isFalse((err as SafeFetchError).retryable)
    }
  })

  test('allowLoopback reaches the in-process listener and returns a Response', async ({
    assert,
  }) => {
    const res = await safeFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      allowLoopback: true,
    })
    assert.equal(res.status, 200)
    const json = (await res.json()) as { ok: boolean; method: string }
    assert.isTrue(json.ok)
    assert.equal(json.method, 'POST')
  })
})
