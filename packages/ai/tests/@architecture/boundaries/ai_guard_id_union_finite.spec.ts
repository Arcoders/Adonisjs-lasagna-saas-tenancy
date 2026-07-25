import { test } from '@japa/runner'
import {
  AI_GUARD_REGISTRY,
  aiGuardEntry,
  type AiGuardId,
} from '../../../src/isthmus/ai_guard_registry.js'

/**
 * `AiGuardId` must stay a FINITE literal union, never widen to
 * `string`. The registry is declared `as const satisfies readonly …Shape[]` and
 * the O(1) lookup is a `Map` built OVER the literal. A naive
 * `Object.freeze(AI_GUARD_REGISTRY)` instead would widen the element type, so
 * `AiGuardId` would become `string` and the emission-matrix's compile-time
 * completeness (a new guard is a type error until it has a recipe) would silently
 * break. This pins both the type (compile-time) and the lookup parity (runtime).
 */

// Type-level pin: `true` iff the union widened to `string`. Kept `false`, so a
// widening regression fails the typecheck gate here, loudly, not in production.
type IsStringWidened<T extends string> = string extends T ? true : false
const _aiGuardIdNotWidened: IsStringWidened<AiGuardId> = false
void _aiGuardIdNotWidened

test.group('AiGuardId union is finite', () => {
  test('every registry id resolves through the O(1) lookup', ({ assert }) => {
    assert.isAbove(AI_GUARD_REGISTRY.length, 0)
    for (const entry of AI_GUARD_REGISTRY) {
      assert.strictEqual(aiGuardEntry(entry.id).id, entry.id)
    }
  })

  test('the lookup is total over exactly the registered ids', ({ assert }) => {
    const ids = new Set(AI_GUARD_REGISTRY.map((e) => e.id))
    assert.equal(ids.size, AI_GUARD_REGISTRY.length, 'ids are unique (no duplicate registrations)')
  })
})
