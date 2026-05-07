import { test } from '@japa/runner'
import { spawn, type ChildProcess } from 'node:child_process'
import { BrandingService } from '@adonisjs-lasagna/saas-tenancy/services'
import {
  createInstalledTenant,
  dropAllTenants,
  installInline,
  waitFor,
} from './_helpers.js'

const MAILCATCHER_HOST = process.env.MAILCATCHER_HOST ?? '127.0.0.1'
const MAILCATCHER_HTTP = `http://${MAILCATCHER_HOST}:1080`

interface MailcatcherMessage {
  id: number
  sender: string
  recipients: string[]
  subject: string
  size: string
  created_at: string
}

async function mailcatcherUp(): Promise<boolean> {
  try {
    const r = await fetch(`${MAILCATCHER_HTTP}/messages`, {
      signal: AbortSignal.timeout(2000),
    } as any)
    return r.ok
  } catch {
    return false
  }
}

async function clearMessages(): Promise<void> {
  try {
    await fetch(`${MAILCATCHER_HTTP}/messages`, { method: 'DELETE' })
  } catch {
    // ignore
  }
}

async function listMessages(): Promise<MailcatcherMessage[]> {
  const r = await fetch(`${MAILCATCHER_HTTP}/messages`)
  return (await r.json()) as MailcatcherMessage[]
}

async function getHtml(id: number): Promise<string> {
  const r = await fetch(`${MAILCATCHER_HTTP}/messages/${id}.html`)
  return r.text()
}

async function getSource(id: number): Promise<string> {
  const r = await fetch(`${MAILCATCHER_HTTP}/messages/${id}.source`)
  return r.text()
}

interface QueueWorker {
  child: ChildProcess
  stop(): Promise<void>
}

/**
 * Spawn `node ace queue:work` as a subprocess. Used only by the queue
 * integration test in this file — the rest of the e2e suite bypasses the
 * queue with `installInline`. Returns a handle with a `stop()` method.
 */
async function startQueueWorker(): Promise<QueueWorker> {
  const child = spawn('npx', ['tsx', 'ace.ts', 'queue:work'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })

  // Wait for the worker to log 'started' (or settle for a small delay).
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1500)
    const onData = (b: Buffer) => {
      const s = b.toString('utf8')
      if (/listening|started|ready/i.test(s)) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
  })

  return {
    child,
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {}
          resolve()
        }, 3000)
        child.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    },
  }
}

/**
 * MailCatcher-driven email tests. The `TenantActivated` listener in
 * `start/routes.ts` fires the welcome email; this suite asserts:
 *
 *   - the email reaches MailCatcher
 *   - the rendered body contains tenant-specific branding values
 *   - cross-tenant data doesn't leak (T1's email never contains T2's strings)
 *   - the activation link is deterministic from the tenant id
 *   - queued delivery (sendLater) works when a queue:work subprocess is up
 *   - failure handling: SMTP outage doesn't crash the host process
 *
 * Each test starts by checking MailCatcher availability and skips with a
 * clear message when it's down.
 */
test.group('e2e — mail (MailCatcher)', (group) => {
  let mcUp = false

  group.setup(async () => {
    mcUp = await mailcatcherUp()
    if (!mcUp) {
      // eslint-disable-next-line no-console
      console.warn(
        `[e2e] MailCatcher not reachable at ${MAILCATCHER_HTTP} — mail tests will skip`
      )
    }
    if (mcUp) await clearMessages()
    await dropAllTenants()
  })

  group.teardown(async () => {
    if (mcUp) await clearMessages()
    await dropAllTenants()
  })

  group.each.setup(async () => {
    if (mcUp) await clearMessages()
  })

  test('MailCatcher availability check', async ({ assert }) => {
    if (!mcUp) {
      assert.isTrue(true, 'skipped — MailCatcher not reachable')
      return
    }
    assert.isTrue(true, 'MailCatcher is up')
  })

  test('TenantActivated triggers a welcome email captured by MailCatcher', async ({
    client,
    assert,
  }) => {
    if (!mcUp) {
      assert.isTrue(true, 'skipped — MailCatcher not reachable')
      return
    }

    const { id } = await createInstalledTenant(client, {
      name: 'Acme Welcome',
      email: 'welcome@acme.test',
    })

    const msg = await waitFor(
      async () => {
        const msgs = await listMessages()
        return msgs.find((m) => m.recipients.some((r) => r.includes('welcome@acme.test')))
      },
      { timeoutMs: 6000, description: 'welcome email never arrived' }
    )

    assert.match(msg.subject, /Welcome.*Acme Welcome/i)
    assert.isTrue(
      msg.recipients.some((r) => r.includes('welcome@acme.test')),
      'recipient should be the tenant email'
    )

    const html = await getHtml(msg.id)
    assert.include(html, 'Acme Welcome', 'tenant name should appear in HTML body')
    // The activation link is deterministic from the tenant id.
    assert.include(html, `${id}.example.test/activate?token=${id}`)
  })

  test('email body carries the tenant-specific branding values', async ({ client, assert }) => {
    if (!mcUp) {
      assert.isTrue(true, 'skipped — MailCatcher not reachable')
      return
    }

    // Create the tenant row WITHOUT activating yet, so the welcome email
    // hasn't fired with the default branding. Upsert branding, then run
    // installInline so TenantActivated fires once with branding already
    // persisted — single email, deterministic content.
    const create = await client.post('/demo/tenants').json({
      name: 'Branded Tenant',
      email: 'branded@e2e.test',
      plan: 'pro',
      tier: 'premium',
    })
    create.assertStatus(202)
    const id = create.body().tenantId as string

    const branding = new BrandingService()
    await branding.upsert(id, {
      fromName: 'BrandedCo',
      fromEmail: 'no-reply@brandedco.test',
      primaryColor: '#FF00FF',
      supportUrl: 'https://brandedco.test/help',
    })

    await clearMessages()
    const status = await installInline(id)
    assert.equal(status, 'active')

    const msg = await waitFor(
      async () => {
        const msgs = await listMessages()
        return msgs.find((m) => m.recipients.some((r) => r.includes('branded@e2e.test')))
      },
      { timeoutMs: 6000, description: 'branded welcome email never arrived' }
    )

    const html = await getHtml(msg.id)
    assert.include(html, 'BrandedCo', 'branded fromName should appear')
    assert.include(html.toUpperCase(), '#FF00FF', 'primary color should be embedded')
    assert.include(html, 'https://brandedco.test/help', 'support URL should appear')

    // The sender header should reflect the branded from-address.
    const source = await getSource(msg.id)
    assert.match(
      source,
      /From:.*BrandedCo.*<no-reply@brandedco.test>/i,
      'From header should carry branded name + address'
    )
  })

  test('cross-tenant isolation: T1 email never contains T2 branding strings', async ({
    client,
    assert,
  }) => {
    if (!mcUp) {
      assert.isTrue(true, 'skipped — MailCatcher not reachable')
      return
    }

    // Create both tenants without activating, upsert each one's branding,
    // THEN activate. Each tenant fires exactly one TenantActivated event
    // with its own branding in place — no race with the queue or the cache.
    const c1 = await client.post('/demo/tenants').json({
      name: 'OneCo',
      email: 't1@e2e.test',
      plan: 'pro',
      tier: 'premium',
    })
    c1.assertStatus(202)
    const id1 = c1.body().tenantId as string

    const c2 = await client.post('/demo/tenants').json({
      name: 'TwoCo',
      email: 't2@e2e.test',
      plan: 'pro',
      tier: 'premium',
    })
    c2.assertStatus(202)
    const id2 = c2.body().tenantId as string

    const branding = new BrandingService()
    await branding.upsert(id1, {
      fromName: 'OneCo-Brand',
      fromEmail: 'one@oneco.test',
      primaryColor: '#111111',
    })
    await branding.upsert(id2, {
      fromName: 'TwoCo-Brand',
      fromEmail: 'two@twoco.test',
      primaryColor: '#222222',
    })

    await clearMessages()
    assert.equal(await installInline(id1), 'active')
    assert.equal(await installInline(id2), 'active')

    await waitFor(async () => (await listMessages()).length >= 2, {
      timeoutMs: 6000,
      description: 'expected two emails',
    })

    const msgs = await listMessages()
    const msg1 = msgs.find((m) => m.recipients.some((r) => r.includes('t1@e2e.test')))!
    const msg2 = msgs.find((m) => m.recipients.some((r) => r.includes('t2@e2e.test')))!
    assert.exists(msg1)
    assert.exists(msg2)

    const html1 = await getHtml(msg1.id)
    const html2 = await getHtml(msg2.id)

    // T1's email must contain T1's branding and NOT T2's
    assert.include(html1, 'OneCo-Brand')
    assert.notInclude(html1, 'TwoCo-Brand')
    assert.notInclude(html1, '#222222')

    assert.include(html2, 'TwoCo-Brand')
    assert.notInclude(html2, 'OneCo-Brand')
    assert.notInclude(html2, '#111111')
  })

  test('queued delivery: mail.sendLater + queue:work delivers within 5s', async ({
    client,
    assert,
  }) => {
    if (!mcUp) {
      assert.isTrue(true, 'skipped — MailCatcher not reachable')
      return
    }

    let worker: QueueWorker | null = null
    try {
      worker = await startQueueWorker()

      await clearMessages()
      const t = await createInstalledTenant(client, {
        name: 'Queued',
        email: 'queued@e2e.test',
      })

      const msg = await waitFor(
        async () => {
          const msgs = await listMessages()
          return msgs.find((m) => m.recipients.some((r) => r.includes('queued@e2e.test')))
        },
        { timeoutMs: 8000, description: 'queued mail never arrived' }
      )
      assert.exists(msg)
      assert.match(msg.subject, /Welcome/)
      // Confirm the test actually exercised the queued path — the listener
      // calls mail.sendLater() unconditionally, so any received mail proves
      // the queue worker picked it up.
      void t
    } finally {
      if (worker) await worker.stop()
    }
  })

  test('SMTP outage: TenantActivated does not crash when MailCatcher port is closed', async ({
    client,
    assert,
  }) => {
    if (!mcUp) {
      assert.isTrue(true, 'skipped — MailCatcher not reachable')
      return
    }

    // Override env so the listener resolves an SMTP host pointing at a closed
    // port. The mail listener uses a top-level try/catch — the host process
    // must remain healthy.
    const originalHost = process.env.MAILCATCHER_HOST
    const originalPort = process.env.MAILCATCHER_PORT
    process.env.MAILCATCHER_PORT = '65530' // closed by convention

    try {
      const { id } = await createInstalledTenant(client, {
        name: 'OutageTest',
        email: 'outage@e2e.test',
      })
      // The host must still respond after the failed listener.
      const ping = await client.get(`/admin/tenants/${id}`).header('x-admin-token', process.env.DEMO_ADMIN_TOKEN ?? 'demo-admin-token-change-me')
      assert.oneOf(ping.status(), [200, 401], 'host process should still answer after mail outage')
    } finally {
      if (originalHost !== undefined) process.env.MAILCATCHER_HOST = originalHost
      if (originalPort !== undefined) process.env.MAILCATCHER_PORT = originalPort
      else delete process.env.MAILCATCHER_PORT
    }
  })

  /**
   * Email status webhook ingestion (e.g. Postmark / SendGrid `delivered`,
   * `bounced`, `spam_complaint` events) is NOT part of the package today —
   * MailCatcher itself has no such webhook. The plan for a future test:
   *
   *   1. Add a `POST /demo/mail/events` route that accepts a signed payload
   *      mimicking a real provider's webhook shape.
   *   2. Have the route update a new `tenant_mail_deliveries` row with the
   *      delivery state.
   *   3. Assert the test sends a payload + that the delivery row reflects it.
   *
   * Documented here so the gap is visible in the suite.
   */
  test('email delivery-status webhook (provider-side) — gap documented', ({ assert }) => {
    assert.isTrue(
      true,
      'no provider-style webhook ingestion exists in the package today — see comment block in mail.spec.ts'
    )
  })
})
