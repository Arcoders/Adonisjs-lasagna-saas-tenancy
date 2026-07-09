import { test } from '@japa/runner'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'
import { ISTHMUS_REGISTRY } from '../../../src/isthmus/registry.js'
import { ISTHMUS_BUDGETS } from '../../../src/isthmus/audit.js'
import { SCOPE_BYPASS_ACTION } from '../../../src/models/scope_bypass_audit.js'
import type { IsthmusSeverity } from '../../../src/types/isthmus.js'

/**
 * The Isthmus contract, pinned so the registry cannot drift from the guards it
 * names:
 *
 *  1. No registered-but-mute guard: every non-audit entry's `guardFile` exists
 *     and contains an `emitIsthmusEvent(` call. (Audit-pillar entries ARE
 *     emitters — the template constructs the registry consolidates — so the
 *     requirement does not apply to them.)
 *  2. No orphan emit: every `emitIsthmusEvent('<id>'` call in src references a
 *     registered id. The compile-time `IsthmusGuardId` union already enforces
 *     this for typed call sites; this textual pass is the belt-and-braces that
 *     also holds for the `.mjs` readers of the same file.
 *  3. Thinness: every entry carries non-empty evidence and ISO review dates —
 *     no speculative guards, and the 6-month review always has a date to act on.
 *  4. Every severity has a finite positive dispatch budget (a security control
 *     must never let its own telemetry become a load amplifier, and no severity
 *     may be accidentally unlimited).
 */

const CORE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SRC_ROOT = join(CORE_ROOT, 'src')

const EMIT_CALL = /emitIsthmusEvent\(\s*'([^']+)'/g
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const TAXONOMY = /^isthmus:(guard|seal|audit):[a-z0-9_]+:[a-z0-9_]+$/

test.group('architectural — the Isthmus contract', () => {
  test('every non-audit registry entry has an existing guardFile that emits', ({ assert }) => {
    const violations: string[] = []
    for (const entry of ISTHMUS_REGISTRY) {
      const file = join(CORE_ROOT, entry.guardFile)
      if (!existsSync(file)) {
        violations.push(`${entry.id}: guardFile does not exist (${entry.guardFile})`)
        continue
      }
      if (entry.pillar === 'audit') continue
      const src = readFileSync(file, 'utf8')
      if (!src.includes(`emitIsthmusEvent('${entry.id}'`)) {
        violations.push(`${entry.id}: ${entry.guardFile} never emits this id — a mute guard`)
      }
    }
    assert.deepEqual(violations, [], `Registered-but-mute guards:\n${violations.join('\n')}`)
  })

  test('every emitIsthmusEvent call in src references a registered id', ({ assert }) => {
    const known = new Set<string>(ISTHMUS_REGISTRY.map((e) => e.id))
    const violations: string[] = []
    for (const file of walkTsFiles(SRC_ROOT)) {
      const src = readFileSync(file, 'utf8')
      for (const match of src.matchAll(EMIT_CALL)) {
        if (!known.has(match[1]!)) {
          violations.push(`${file}: emitIsthmusEvent('${match[1]}') has no registry entry`)
        }
      }
    }
    assert.deepEqual(violations, [], `Orphan emit calls:\n${violations.join('\n')}`)
  })

  test('every entry carries evidence, review dates, and a taxonomy-conformant event name', ({
    assert,
  }) => {
    const violations: string[] = []
    const ids = new Set<string>()
    for (const entry of ISTHMUS_REGISTRY) {
      if (ids.has(entry.id)) violations.push(`${entry.id}: duplicate id`)
      ids.add(entry.id)
      if (!entry.evidence.ref.trim()) violations.push(`${entry.id}: empty evidence.ref`)
      if (!ISO_DATE.test(entry.reviewed)) violations.push(`${entry.id}: bad reviewed date`)
      if (!ISO_DATE.test(entry.nextReview)) violations.push(`${entry.id}: bad nextReview date`)
      if (!entry.id.startsWith(`${entry.pillar}.`)) {
        violations.push(`${entry.id}: id prefix does not match pillar "${entry.pillar}"`)
      }
      // New events follow the taxonomy; the one grandfathered name is the
      // scope-bypass template's shipped action (renaming it would break hosts).
      if (!TAXONOMY.test(entry.event) && entry.event !== SCOPE_BYPASS_ACTION) {
        violations.push(`${entry.id}: event "${entry.event}" violates the taxonomy`)
      }
    }
    assert.deepEqual(violations, [], `Thinness violations:\n${violations.join('\n')}`)
  })

  test('every severity has a finite positive dispatch budget', ({ assert }) => {
    const severities: IsthmusSeverity[] = ['critical', 'high', 'warn', 'info']
    for (const s of severities) {
      const budget = ISTHMUS_BUDGETS[s]
      assert.isTrue(
        Number.isInteger(budget) && budget > 0 && Number.isFinite(budget),
        `ISTHMUS_BUDGETS.${s} must be a finite positive integer, got ${budget}`
      )
    }
  })

  test('the CI gate regexes still parse every registry entry (parse-drift pin)', ({ assert }) => {
    // These two regexes are COPIES of the ones scripts/check-isthmus.mjs uses to
    // read registry.ts textually (it can't import TS). They are field-order
    // dependent (id → guardFile → nextReview; evidence.kind → ref). A field
    // reorder or shape change in registry.ts silently skews the CI Index — this
    // pins the parse so that drift fails the unit suite first. Keep in sync with
    // check-isthmus.mjs:entryRe / evidenceRe.
    const entryRe =
      /\{\s*id:\s*'([^']+)'[\s\S]*?guardFile:\s*'([^']+)'[\s\S]*?nextReview:\s*'([^']+)'\s*,?\s*\}/g
    const evidenceRe = /evidence:\s*\{\s*kind:\s*'([^']*)'\s*,\s*ref:\s*'([^']*)'/

    const src = readFileSync(join(SRC_ROOT, 'isthmus/registry.ts'), 'utf8')
    const parsedIds: string[] = []
    for (const m of src.matchAll(entryRe)) {
      parsedIds.push(m[1]!)
      const block = m[0]
      const ev = block.match(evidenceRe)
      assert.isNotNull(ev, `${m[1]}: check-isthmus evidence regex failed to parse evidence`)
      assert.isAbove((ev![2] ?? '').trim().length, 0, `${m[1]}: evidence.ref parsed empty`)
    }

    assert.equal(
      parsedIds.length,
      ISTHMUS_REGISTRY.length,
      'the CI gate would parse a different entry count than the registry actually has'
    )
    assert.deepEqual(
      [...parsedIds].sort(),
      ISTHMUS_REGISTRY.map((e) => e.id).sort(),
      'the CI gate would parse different ids than the registry exports'
    )
  })

  test('detector controls: the matchers are not vacuously true', ({ assert }) => {
    const hits = [...`emitIsthmusEvent('guard.tenant_identifier', {})`.matchAll(EMIT_CALL)]
    assert.lengthOf(hits, 1)
    assert.equal(hits[0]![1], 'guard.tenant_identifier')
    assert.lengthOf([...`someOtherEmit('guard.x')`.matchAll(EMIT_CALL)], 0)
    assert.isTrue(TAXONOMY.test('isthmus:guard:identifier:rejected'))
    assert.isFalse(TAXONOMY.test('scope:bypass'))
    assert.isFalse(TAXONOMY.test('isthmus:other:x:y'))
  })
})
