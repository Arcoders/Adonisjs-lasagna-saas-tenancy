import { test } from '@japa/runner'
import { assertSafeIdentifier } from '@adonisjs-lasagna/saas-tenancy/services'
import { collectSnapshot, renderPrometheus } from '@adonisjs-lasagna/saas-tenancy/health'

/**
 * The Isthmus counters wire through to the /metrics scrape end-to-end. Thin on
 * purpose: label formats are unit-pinned (behavior_metrics_exporter), so this
 * proves the wiring — collectSnapshot() carries the live counters and
 * renderPrometheus() renders the four families.
 *
 * DELTA-ONLY: the integration suite shares one process and the reset seams are
 * not on /internal, so other specs have already tripped guards. The trip goes
 * through the package's build-instance export (assertSafeIdentifier from
 * /services) — a relative src import would bump a different module instance than
 * the booted app + collectSnapshot read.
 */

/** Parse `multitenancy_isthmus_rejected_total{...,id="X"} N` → N (0 if absent). */
function rejectedFor(scrape: string, id: string): number {
  const line = scrape
    .split('\n')
    .find((l) => l.startsWith('multitenancy_isthmus_rejected_total') && l.includes(`id="${id}"`))
  if (!line) return 0
  return Number(line.slice(line.lastIndexOf(' ') + 1))
}

test.group('Isthmus counters render on the /metrics scrape (integration)', () => {
  test('tripping a guard increments its rejected_total by exactly one', async ({ assert }) => {
    const before = renderPrometheus(
      await collectSnapshot({ includeTenants: false, includeQueues: false })
    )
    const rejectedBefore = rejectedFor(before, 'guard.tenant_identifier')

    // Trip the identifier guard through the build instance.
    assert.throws(() => assertSafeIdentifier('metrics@scrape', 'tenant id'))

    const after = renderPrometheus(
      await collectSnapshot({ includeTenants: false, includeQueues: false })
    )

    // All four families are present once at least one guard has tripped.
    assert.include(after, '# TYPE multitenancy_isthmus_guarded_total counter')
    assert.include(after, '# TYPE multitenancy_isthmus_rejected_total counter')
    assert.include(after, '# TYPE multitenancy_isthmus_dropped_total counter')
    assert.include(after, '# TYPE multitenancy_isthmus_index gauge')

    assert.equal(
      rejectedFor(after, 'guard.tenant_identifier') - rejectedBefore,
      1,
      'exactly one new rejection is counted for the tripped guard'
    )

    // The index gauge renders in (0, 1].
    const indexLine = after.split('\n').find((l) => l.startsWith('multitenancy_isthmus_index '))
    assert.isDefined(indexLine)
    const index = Number(indexLine!.slice(indexLine!.lastIndexOf(' ') + 1))
    assert.isAbove(index, 0)
    assert.isAtMost(index, 1)
  })
})
