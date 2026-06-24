import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { ExtensionTimeoutError } from '@adonisjs-lasagna/saas-tenancy/services'
import ReportExtensionRegistry from '../../src/report_extension_registry.js'
import ReportingDashboardController from '../../src/controllers/reporting_dashboard_controller.js'
import { REPORTING_CONTRACT_VERSION } from '../../src/constants.js'
import { createTestExtension } from '../../src/testing/extension_helpers.js'
import type {
  ReportExtension,
  ReportExtensionFilters,
} from '../../src/contracts/report_extension.js'

interface Captured {
  status: number
  body: any
}

function makeCtx(name: string, input: Record<string, unknown> = {}) {
  const captured: Captured = { status: 0, body: undefined }
  const respond = (status: number) => (body: any) => {
    captured.status = status
    captured.body = body
    return body
  }
  const ctx = {
    params: { name },
    request: { input: (k: string, d?: unknown) => (k in input ? input[k] : d) },
    response: { ok: respond(200), badRequest: respond(400), notFound: respond(404) },
  } as any
  return { ctx, captured }
}

function bindRegistry(registry: ReportExtensionRegistry) {
  app.container.singleton(ReportExtensionRegistry, () => registry)
}

class OkExtension implements ReportExtension {
  name = 'demo_report'
  description = 'demo'
  lastFilters?: ReportExtensionFilters
  async execute(filters: ReportExtensionFilters) {
    this.lastFilters = filters
    return { rows: [{ tenant: 'a', value: 1 }] }
  }
}

class BoomExtension implements ReportExtension {
  name = 'boom_report'
  description = 'always throws'
  async execute(): Promise<unknown> {
    throw new Error('extension blew up')
  }
}

test.group('report extensions (integration)', () => {
  test('runs a registered extension and returns its result', async ({ assert }) => {
    const ext = new OkExtension()
    bindRegistry(new ReportExtensionRegistry().register(ext))
    const controller = new ReportingDashboardController()
    const { ctx, captured } = makeCtx('demo_report', { since: '2026-01-01', until: '2026-02-01' })

    await controller.extension(ctx)

    assert.equal(captured.status, 200)
    assert.deepEqual(captured.body.data, { rows: [{ tenant: 'a', value: 1 }] })
    assert.deepEqual(ext.lastFilters, {
      since: '2026-01-01',
      until: '2026-02-01',
      period: undefined,
    })
  })

  test('unknown extension → 404', async ({ assert }) => {
    bindRegistry(new ReportExtensionRegistry())
    const controller = new ReportingDashboardController()
    const { ctx, captured } = makeCtx('nope')
    await controller.extension(ctx)
    assert.equal(captured.status, 404)
  })

  test('CHAOS: a malicious :name is rejected as 404 (never a registry lookup on unsafe input)', async ({
    assert,
  }) => {
    bindRegistry(new ReportExtensionRegistry().register(new OkExtension()))
    const controller = new ReportingDashboardController()
    const { ctx, captured } = makeCtx("demo'; DROP TABLE x; --")
    await controller.extension(ctx)
    assert.equal(captured.status, 404)
  })

  test('CHAOS: a throwing extension surfaces cleanly and leaves the registry usable', async ({
    assert,
  }) => {
    const registry = new ReportExtensionRegistry()
    registry.register(new BoomExtension())
    registry.register(new OkExtension())
    bindRegistry(registry)
    const controller = new ReportingDashboardController()

    await assert.rejects(
      () => controller.extension(makeCtx('boom_report').ctx),
      /extension blew up/
    )

    // The registry is uncorrupted — a different extension still runs.
    const { ctx, captured } = makeCtx('demo_report')
    await controller.extension(ctx)
    assert.equal(captured.status, 200)
  })

  test('a host extension can run safe backoffice work via execute()', async ({ assert }) => {
    // Proves the documented escape hatch: an extension does its own work and the
    // registry returns its result unchanged.
    const ext: ReportExtension = {
      name: 'counter',
      description: 'counts',
      async execute(filters) {
        return { window: filters, count: 3 }
      },
    }
    bindRegistry(new ReportExtensionRegistry().register(ext))
    const controller = new ReportingDashboardController()
    const { ctx, captured } = makeCtx('counter', { period: 'week' })
    await controller.extension(ctx)
    assert.equal(captured.status, 200)
    assert.equal(captured.body.data.count, 3)
  })

  test('contract-version endpoint reports the surface version', async ({ assert }) => {
    const controller = new ReportingDashboardController()
    const { ctx, captured } = makeCtx('ignored')
    await controller.contractVersion(ctx)
    assert.equal(captured.status, 200)
    assert.deepEqual(captured.body, { version: REPORTING_CONTRACT_VERSION })
  })
})

test.group('report extensions — execution guards (integration)', (group) => {
  // The timeout guard reads `reporting.extensions.timeoutMs` from config; seed it
  // for this group only and restore the original afterwards (the config singleton
  // is shared across the booted suite).
  let original: any
  group.each.setup(() => {
    original = app.config.get('multitenancy')
  })
  group.each.teardown(() => {
    app.config.set('multitenancy', original)
  })

  test('CHAOS: a slow extension trips the configured timeout (504)', async ({ assert }) => {
    app.config.set('multitenancy', { ...original, reporting: { extensions: { timeoutMs: 20 } } })
    bindRegistry(
      new ReportExtensionRegistry().register(createTestExtension({ name: 'slow', delayMs: 500 }))
    )
    const controller = new ReportingDashboardController()
    await assert.rejects(() => controller.extension(makeCtx('slow').ctx), ExtensionTimeoutError)
  })

  test('a fast extension finishes within the timeout', async ({ assert }) => {
    app.config.set('multitenancy', { ...original, reporting: { extensions: { timeoutMs: 500 } } })
    bindRegistry(
      new ReportExtensionRegistry().register(
        createTestExtension({ name: 'fast', result: { ok: true } })
      )
    )
    const controller = new ReportingDashboardController()
    const { ctx, captured } = makeCtx('fast')
    await controller.extension(ctx)
    assert.equal(captured.status, 200)
    assert.deepEqual(captured.body.data, { ok: true })
  })
})
