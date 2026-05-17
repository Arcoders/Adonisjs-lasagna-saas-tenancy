import { test } from '@japa/runner'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import { TenantWebhookDelivery } from '@adonisjs-lasagna/saas-tenancy'
import { createInstalledTenant, dropAllTenants, runAce, waitFor } from './_helpers.js'

interface CapturedRequest {
  headers: Record<string, string | string[] | undefined>
  body: string
}

/**
 * Boots an in-process HTTP listener, subscribes a tenant to it via
 * `POST /demo/webhooks`, fires a test event via `POST /demo/webhooks/fire`,
 * and asserts:
 *   - the listener received the POST
 *   - the body is the JSON payload
 *   - the `x-webhook-signature` header is a valid HMAC-SHA256 of the body
 *     using the registered secret
 *
 * Then exercises the failure path against a closed port and runs
 * `tenant:webhooks:retry` to confirm the retry queue logic.
 */
test.group('e2e — webhook delivery + HMAC + retry', (group) => {
  let server: http.Server
  let port: number
  let received: CapturedRequest[] = []

  group.setup(async () => {
    await dropAllTenants()

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        received.push({
          headers: req.headers as any,
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.statusCode = 200
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    port = typeof addr === 'object' && addr ? addr.port : 0
  })

  group.teardown(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await dropAllTenants()
  })

  group.each.setup(() => {
    received = []
  })

  test('POST /demo/webhooks/fire delivers a signed POST to the subscriber URL', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const url = `http://127.0.0.1:${port}/captured`
    const secret = 'shared-secret'

    const sub = await client
      .post('/demo/webhooks')
      .header('x-tenant-id', id)
      .json({ url, events: ['demo.fired'], secret })
    sub.assertStatus(201)

    const fire = await client
      .post('/demo/webhooks/fire')
      .header('x-tenant-id', id)
      .json({ event: 'demo.fired', payload: { hello: 'world', n: 7 } })
    fire.assertStatus(202)

    const captured = await waitFor(() => (received.length > 0 ? received[0] : null), {
      timeoutMs: 3000,
      description: 'webhook never arrived at in-process listener',
    })

    assert.equal(captured.headers['x-webhook-event'], 'demo.fired')
    assert.equal(captured.headers['content-type'], 'application/json')

    const parsed = JSON.parse(captured.body)
    assert.equal(parsed.hello, 'world')
    assert.equal(parsed.n, 7)

    const expectedSig = createHmac('sha256', secret).update(captured.body).digest('hex')
    assert.equal(
      captured.headers['x-webhook-signature'],
      expectedSig,
      'HMAC-SHA256 signature did not match the registered secret'
    )
  })

  test('subscriptions without a secret omit the signature header', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const url = `http://127.0.0.1:${port}/no-secret`

    const sub = await client
      .post('/demo/webhooks')
      .header('x-tenant-id', id)
      .json({ url, events: ['demo.unsigned'] })
    sub.assertStatus(201)

    const fire = await client
      .post('/demo/webhooks/fire')
      .header('x-tenant-id', id)
      .json({ event: 'demo.unsigned', payload: { ok: true } })
    fire.assertStatus(202)

    const captured = await waitFor(() => (received.length > 0 ? received[0] : null), {
      timeoutMs: 3000,
    })
    assert.isUndefined(captured.headers['x-webhook-signature'])
  })

  test('failed deliveries land in the retry queue with attempts >= 1', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)

    // Port 1 is reserved (always closed). Anything we POST there will fail
    // with a connection error inside fetch.
    const sub = await client
      .post('/demo/webhooks')
      .header('x-tenant-id', id)
      .json({ url: 'http://127.0.0.1:1/never', events: ['demo.failing'] })
    sub.assertStatus(201)

    const fire = await client
      .post('/demo/webhooks/fire')
      .header('x-tenant-id', id)
      .json({ event: 'demo.failing', payload: {} })
    fire.assertStatus(202)

    // After dispatch, the delivery row should exist with a retrying/failed
    // status.
    const delivery = await waitFor(
      async () => {
        const row = await TenantWebhookDelivery.query()
          .where('event', 'demo.failing')
          .orderBy('created_at', 'desc')
          .first()
        return row && row.attempt >= 1 ? row : null
      },
      { timeoutMs: 5000, description: 'failing delivery row never appeared' }
    )

    assert.oneOf(delivery.status, ['retrying', 'failed'])
    assert.isAtLeast(delivery.attempt, 1)
  })

  test('tenant:webhooks:retry processes pending retries without crashing', async ({
    assert,
  }) => {
    // The previous test left a retrying delivery in the DB. The command
    // should pick it up (or no-op if its `next_retry_at` hasn't elapsed).
    // Either way, exit code is 0.
    const code = await runAce('tenant:webhooks:retry')
    assert.equal(code, 0)
  })
})
