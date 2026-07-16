import { test } from '@japa/runner'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AIException from '../../../../src/exceptions/ai_exception.js'

test.group('security — per-tenant tool-loop concurrency cap (Phase 2a)', () => {
  test('refuses the (N+1)th concurrent acquire with a 429 too_many_concurrent', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    const cap = 2
    watcher.acquire('t1', { maxConcurrent: cap })
    watcher.acquire('t1', { maxConcurrent: cap })

    const err = assert.throws(
      () => watcher.acquire('t1', { maxConcurrent: cap }),
      /too many concurrent/i
    )
    assert.instanceOf(err, AIException)
    assert.equal((err as AIException).aiCode, 'too_many_concurrent')
    assert.equal((err as AIException).httpStatus, 429)
  })

  test('a refused acquire creates no handle; disposing one frees a slot', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    const cap = 2
    const h1 = watcher.acquire('t1', { maxConcurrent: cap })
    watcher.acquire('t1', { maxConcurrent: cap })

    // Refused: the in-flight count is unchanged, so a dispose still frees exactly one.
    assert.throws(() => watcher.acquire('t1', { maxConcurrent: cap }))
    h1.dispose()
    assert.doesNotThrow(() => watcher.acquire('t1', { maxConcurrent: cap }))
  })

  test('an uncapped acquire (plain chat / embed / retrieve) is never refused', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    for (let i = 0; i < 50; i++) watcher.acquire('t1')
    assert.equal(watcher.watchedTenantCount(), 1)
  })

  test('the cap is per-tenant: one tenant at its cap never blocks another', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    watcher.acquire('a', { maxConcurrent: 1 })
    assert.throws(() => watcher.acquire('a', { maxConcurrent: 1 }), /too many concurrent/i)
    assert.doesNotThrow(() => watcher.acquire('b', { maxConcurrent: 1 }))
  })

  test('the cap gates a tool loop on TOTAL in-flight: uncapped streams count toward it', ({
    assert,
  }) => {
    // The cap deliberately reuses the shared liveness set (no new registry), so it
    // is an admission gate on the tenant's total live streams, not a tool-loop-exact
    // counter. Three uncapped streams (plain chat / embed / retrieve) already saturate
    // a cap of 3, so a NEW tool loop is refused even though no tool loop is running.
    const watcher = new TenantLivenessWatcher()
    watcher.acquire('t1')
    watcher.acquire('t1')
    watcher.acquire('t1')
    const err = assert.throws(
      () => watcher.acquire('t1', { maxConcurrent: 3 }),
      /too many concurrent AI streams/i
    )
    assert.equal((err as AIException).aiCode, 'too_many_concurrent')
    // The message does not falsely claim there are three concurrent tool loops.
    assert.notMatch((err as AIException).message, /concurrent AI tool loops/i)
  })
})
