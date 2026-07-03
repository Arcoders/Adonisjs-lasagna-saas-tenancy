import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import AiComplianceService, {
  type AiComplianceDeps,
} from '../../../../src/services/ai_compliance_service.js'
import { hashAuditPrincipal } from '../../../../src/gateway/audit_seam.js'
import {
  snapshotAiGuardCounters,
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'

/**
 * WS-AI-9 compliance orchestrator: the E1 raw-vs-hash asymmetry (memory keys the
 * raw principal, embeddings its SHA-256 actor), the bumpEpoch GATE (a failed
 * rotation aborts the deletes), the honest per-step summary on a partial failure
 * (E22), the concurrent-purge lock (E15), and the non-throwing auto-purge that
 * emits `guard.ai_auto_purge_failed` (E6).
 */

const tenant = { id: 'tenant-c' } as unknown as TenantModelContract

class FakeMemory {
  purgeTenantCalls: string[] = []
  purgeUserCalls: Array<{ tenantId: string; principal: string }> = []
  throwOnTenant = false
  async purgeTenant(tenantId: string): Promise<number> {
    this.purgeTenantCalls.push(tenantId)
    if (this.throwOnTenant) throw new Error('memory store down')
    return 3
  }
  async purgeUser(tenantId: string, principal: string): Promise<number> {
    this.purgeUserCalls.push({ tenantId, principal })
    return 2
  }
}

class FakeVector {
  purgeTenantCalls = 0
  deleteByActorArgs: string[] = []
  deleteBySourceArgs: string[] = []
  async purgeTenant(): Promise<number> {
    this.purgeTenantCalls += 1
    return 5
  }
  async deleteByActor(_t: TenantModelContract, actorHash: string): Promise<number> {
    this.deleteByActorArgs.push(actorHash)
    return 4
  }
  async deleteBySource(_t: TenantModelContract, source: string): Promise<number> {
    this.deleteBySourceArgs.push(source)
    return 1
  }
}

class FakeIdempotency {
  bumpCalls: string[] = []
  fail = false
  async bumpEpoch(tenantId: string): Promise<void> {
    this.bumpCalls.push(tenantId)
    if (this.fail) throw new Error('epoch store down')
  }
}

function build(over: Partial<AiComplianceDeps> = {}) {
  const memory = new FakeMemory()
  const vectorStore = new FakeVector()
  const idempotency = new FakeIdempotency()
  const metrics: Array<{ name: string; value: number }> = []
  const audits: Array<Record<string, unknown>> = []
  const lockStore = new Set<string>()
  const deps: AiComplianceDeps = {
    memory: memory as never,
    vectorStore: vectorStore as never,
    idempotency: idempotency as never,
    runScoped: (_t, fn) => fn(),
    embeddingsEnabled: true,
    getRedis: async () => ({
      async set(key: string, _v: string, ..._args: unknown[]) {
        if (lockStore.has(key)) return null
        lockStore.add(key)
        return 'OK'
      },
      async del(key: string) {
        lockStore.delete(key)
      },
    }),
    auditLog: async (o) => {
      audits.push(o)
    },
    metric: (_t, name, value) => metrics.push({ name, value }),
    ...over,
  }
  return {
    svc: new AiComplianceService(deps),
    memory,
    vectorStore,
    idempotency,
    metrics,
    audits,
    lockStore,
  }
}

test.group('behavior — AiComplianceService (WS-AI-9)', (group) => {
  group.each.setup(() => {
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async () => {})
  })
  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('purgeUser feeds the RAW principal to memory and its SHA-256 to embeddings (E1)', async ({
    assert,
  }) => {
    const { svc, memory, vectorStore } = build()
    const summary = await svc.purgeUser(tenant, 'user-123')
    assert.isTrue(summary.ok)
    assert.deepEqual(memory.purgeUserCalls, [{ tenantId: 'tenant-c', principal: 'user-123' }])
    assert.deepEqual(vectorStore.deleteByActorArgs, [hashAuditPrincipal('user-123')])
    assert.notEqual(vectorStore.deleteByActorArgs[0], 'user-123') // never the raw value
  })

  test('purgeTenant runs epoch, memory, embeddings in order with an ok summary', async ({
    assert,
  }) => {
    const { svc, idempotency, memory, vectorStore } = build()
    const summary = await svc.purgeTenant(tenant)
    assert.isTrue(summary.ok)
    assert.deepEqual(idempotency.bumpCalls, ['tenant-c'])
    assert.deepEqual(memory.purgeTenantCalls, ['tenant-c'])
    assert.equal(vectorStore.purgeTenantCalls, 1)
    assert.deepEqual(
      summary.steps.map((s) => [s.step, s.status, s.count]),
      [
        ['epoch', 'ok', undefined],
        ['memory', 'ok', 3],
        ['embeddings', 'ok', 5],
      ]
    )
  })

  test('a failed bumpEpoch GATES the deletes (nothing else attempted)', async ({ assert }) => {
    const { svc, idempotency, memory, vectorStore } = build()
    idempotency.fail = true
    const summary = await svc.purgeTenant(tenant)
    assert.isFalse(summary.ok)
    assert.deepEqual(memory.purgeTenantCalls, []) // never called
    assert.equal(vectorStore.purgeTenantCalls, 0) // never called
    assert.deepEqual(
      summary.steps.map((s) => [s.step, s.status]),
      [['epoch', 'failed']]
    )
  })

  test('a memory failure does not stop embeddings (best-effort-continue, honest summary E22)', async ({
    assert,
  }) => {
    const { svc, memory, vectorStore } = build()
    memory.throwOnTenant = true
    const summary = await svc.purgeTenant(tenant)
    assert.isFalse(summary.ok)
    assert.equal(vectorStore.purgeTenantCalls, 1) // embeddings still purged
    assert.deepEqual(
      summary.steps.map((s) => [s.step, s.status]),
      [
        ['epoch', 'ok'],
        ['memory', 'failed'],
        ['embeddings', 'ok'],
      ]
    )
  })

  test('embeddings are skipped when not configured', async ({ assert }) => {
    const { svc, vectorStore } = build({ embeddingsEnabled: false })
    const summary = await svc.purgeTenant(tenant)
    assert.equal(vectorStore.purgeTenantCalls, 0)
    assert.deepEqual(
      summary.steps.find((s) => s.step === 'embeddings'),
      {
        step: 'embeddings',
        status: 'skipped',
        code: 'embeddings_not_configured',
      }
    )
  })

  test('a concurrent purge is skipped by the per-tenant lock (E15)', async ({ assert }) => {
    const { svc, lockStore } = build()
    lockStore.add('ai:purge:lock:tenant-c') // a purge is already holding the lock
    const summary = await svc.purgeTenant(tenant)
    assert.isFalse(summary.ok)
    assert.equal(summary.steps[0].code, 'purge_in_progress')
  })

  test('a best-effort kernel-audit failure never flips the purge', async ({ assert }) => {
    const { svc } = build({
      auditLog: async () => {
        throw new Error('audit db down')
      },
    })
    const summary = await svc.purgeTenant(tenant)
    assert.isTrue(summary.ok) // the data ops succeeded; the audit is best-effort
  })

  test('autoPurge is non-throwing and emits guard.ai_auto_purge_failed on failure (E6)', async ({
    assert,
  }) => {
    const { svc, idempotency, vectorStore } = build()
    idempotency.fail = true
    await svc.autoPurge(tenant, 'tenant_deleted') // must not throw
    assert.equal(vectorStore.purgeTenantCalls, 0) // lifecycle path never touches embeddings
    assert.include(
      snapshotAiGuardCounters().rejected.map((r) => r.id),
      'guard.ai_auto_purge_failed'
    )
  })

  test('autoPurge on a healthy store purges memory + epoch only, no guard', async ({ assert }) => {
    const { svc, memory, vectorStore } = build()
    await svc.autoPurge(tenant, 'tenant_anonymized')
    assert.deepEqual(memory.purgeTenantCalls, ['tenant-c'])
    assert.equal(vectorStore.purgeTenantCalls, 0)
    assert.isEmpty(snapshotAiGuardCounters().rejected)
  })
})
