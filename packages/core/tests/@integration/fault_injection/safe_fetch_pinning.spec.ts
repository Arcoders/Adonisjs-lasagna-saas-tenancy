import { test } from '@japa/runner'
import { createServer, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { type AddressInfo } from 'node:net'
import { pinnedLookup, safeFetch, SafeFetchError } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'

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

  test('the pin survives a real https connect under Node Happy-Eyeballs', async ({ assert }) => {
    // safeFetch cannot exercise the COMPLETING pinned path against a local server:
    // pinned mode blocks every private/loopback range by design, so the httpsRequest
    // + custom lookup only ever runs against a public address. We drive the exact
    // pin helper through a real https.request against the in-process listener with
    // autoSelectFamily left at its Node-24 default (true). The single-address lookup
    // shape used before this fix throws ERR_INVALID_IP_ADDRESS here at connect (Node
    // Happy-Eyeballs calls a custom lookup with { all:true } and requires an array);
    // the { all }-aware pin reaches the TLS layer instead. The plain-HTTP listener
    // then fails the handshake, which is the point: the connection was established.
    const port = (server.address() as AddressInfo).port
    const outcome = await new Promise<{ code?: string; phase: string }>((resolve) => {
      const req = httpsRequest(
        {
          host: 'pinned.example', // a NAME, so Node invokes the custom lookup (the pin path)
          servername: 'pinned.example',
          port,
          path: '/',
          method: 'GET',
          lookup: pinnedLookup('127.0.0.1', 4),
        },
        () => resolve({ phase: 'response' })
      )
      req.on('error', (err: NodeJS.ErrnoException) => resolve({ code: err.code, phase: 'error' }))
      req.setTimeout(3000, () => {
        req.destroy(new Error('timeout'))
        resolve({ phase: 'timeout' })
      })
      req.end()
    })
    assert.notEqual(
      outcome.code,
      'ERR_INVALID_IP_ADDRESS',
      'the pin lookup must not break the connect layer on Node 24'
    )
    assert.equal(outcome.phase, 'error', 'connect reached TLS against the plain-HTTP listener')
  })
})
