import { test } from '@japa/runner'
import { HttpContext } from '@adonisjs/core/http'
import TenantAdapter from '../../../../src/models/adapters/tenant_adapter.js'
import IsolationDriverRegistry from '../../../../src/services/isolation/registry.js'
import SchemaPgDriver from '../../../../src/services/isolation/schema_pg_driver.js'
import IsthmusTenantMismatchException from '../../../../src/exceptions/isthmus_tenant_mismatch_exception.js'
import { setConfig } from '../../../../src/config.js'
import { __resetConfigForTests } from '../../../../src/testing/config_reset.js'
import { testConfig } from '../../../helpers/config.js'
import {
  createGuardAudit,
  type GuardAuditEntry,
} from '../../../../src/sdk/guard_audit.js'
import { tenancy, __configureTenancyForTests } from '../../../../src/tenancy.js'
import TenantLogContext from '../../../../src/services/tenant_log_context.js'
import BootstrapperRegistry from '../../../../src/services/bootstrapper_registry.js'
import type { IsthmusGuardTrippedPayload } from '../../../../src/types/isthmus.js'

/**
 * WS-1 M1 — the Isthmus is CHEAP, pinned as an operation-count invariant (never
 * wall-clock, per the house rule). Two guarantees fail CI on regression:
 *
 *   1. The ContextSeal adds ZERO SQL round-trips. Routing a model query through
 *      `TenantAdapter` resolves exactly one connection; the seal is a string
 *      compare over the request memo, not a query. A mismatch fails closed BEFORE
 *      any connection is resolved (zero round-trips on the reject path too).
 *   2. `emit()` on a guard trip is O(1): a bounded, constant number of operations
 *      (two counter bumps + at most one fire-and-forget dispatch), and the counter
 *      maps are keyed by guard, so they do not grow with trip VOLUME.
 */

const UUID1 = '11111111-1111-4111-8111-111111111111'
const UUID2 = '22222222-2222-4222-8222-222222222222'
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function makeRegistry() {
  const reg = new IsolationDriverRegistry()
  reg.register(new SchemaPgDriver())
  return reg
}

function makeRequest(headers: Record<string, string>) {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    hostname: () => (lower['host'] ?? '').split(':')[0],
    url: () => '/',
    header: (key: string) => lower[key.toLowerCase()] ?? null,
  }
}

function makeMockDb() {
  const calls: string[] = []
  return {
    connection: (name?: string) => {
      calls.push(name ?? '__undefined__')
      return `client:${String(name)}`
    },
    calls,
  }
}

test.group('performance — ContextSeal adds no SQL round-trip', (group) => {
  let originalGet: typeof HttpContext.get

  group.each.setup(() => {
    __resetConfigForTests()
    setConfig({ ...testConfig, resolverStrategy: 'header' })
    originalGet = HttpContext.get
    __configureTenancyForTests({
      logCtx: new TenantLogContext(),
      registry: new BootstrapperRegistry(),
    })
  })

  group.each.teardown(() => {
    ;(HttpContext as any).get = originalGet
    __configureTenancyForTests({})
    __resetConfigForTests()
  })

  test('an agreeing seal resolves exactly one connection per query (zero seal round-trips)', async ({
    assert,
  }) => {
    ;(HttpContext as any).get = () => ({ request: makeRequest({ 'x-tenant-id': UUID1 }) })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    const N = 25
    await tenancy.run({ id: UUID1 } as any, async () => {
      for (let i = 0; i < N; i++) adapter.modelConstructorClient({} as any)
    })

    // One connection resolution per routed query and no more: the seal itself
    // issues no query. If the seal ever did IO, this would be > N.
    assert.lengthOf(db.calls, N, 'the seal adds no extra connection resolution')
    assert.isTrue(
      db.calls.every((c) => c === `tenant_${UUID1}`),
      'every query routed to the tenant connection'
    )
  })

  test('a mismatching seal fails closed with ZERO connection resolutions', async ({ assert }) => {
    ;(HttpContext as any).get = () => ({ request: makeRequest({ 'x-tenant-id': UUID1 }) })
    const db = makeMockDb()
    const adapter = new TenantAdapter(db as any, makeRegistry())

    await tenancy.run({ id: UUID2 } as any, async () => {
      assert.throws(() => adapter.modelConstructorClient({} as any), IsthmusTenantMismatchException)
    })

    assert.lengthOf(db.calls, 0, 'the reject path never resolves a connection')
  })
})

test.group('performance — emit is O(1) per trip', () => {
  const ENTRY: GuardAuditEntry = {
    id: 'guard.synthetic',
    pillar: 'guard',
    bugClass: 'perf-test',
    severity: 'high',
    event: 'isthmus:guard:synthetic:rejected',
  }

  test('a trip issues a bounded, constant op set; counters do not grow with volume', async ({
    assert,
  }) => {
    const captured: IsthmusGuardTrippedPayload[] = []
    const audit = createGuardAudit<'guard.synthetic'>({ lookup: () => ENTRY })
    audit.setDispatcher(async (p) => {
      captured.push(p)
    })

    const K = 500
    for (let i = 0; i < K; i++) audit.emit('guard.synthetic', { tenantId: UUID1 })
    await settle()

    const snap = audit.snapshot()
    // The counter maps are keyed by guard/severity, not by trip: K trips of ONE
    // guard produce exactly ONE rejected row and ONE guarded row, so emit is O(1)
    // in space regardless of volume.
    assert.lengthOf(snap.rejected, 1, 'one rejected row for one guard, not K rows')
    assert.lengthOf(snap.guarded, 1, 'one guarded row for one severity, not K rows')
    assert.equal(snap.rejected[0]!.value, K, 'every trip is counted')
    // Dispatch is bounded by the severity window budget (finite), never K.
    assert.isBelow(captured.length, K, 'dispatch is rate-limited to a finite budget, not per-trip')
  })
})
