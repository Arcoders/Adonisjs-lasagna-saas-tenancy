import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from '../../../../satellite-test-kit/src/repo_root.js'
import { TENANT_STATUSES } from '../../../src/types/contracts.js'

/**
 * Docs-integrity guard: every tenant lifecycle status is documented in the
 * architecture reference's status enum. Paired with the `check-tenant-statuses` source
 * guard, this closes the loop so a new status cannot ship undocumented. Reads files
 * only (no Ignitor), so it runs in the architectural group under `test:integrity`.
 */
const ARCH_DOC = join(repoRoot(import.meta.url), 'docs', 'architecture.md')

test.group('Docs integrity: tenant statuses', () => {
  test('every TENANT_STATUSES value appears in the architecture status enum', ({ assert }) => {
    const doc = readFileSync(ARCH_DOC, 'utf8')
    const enumMatch = doc.match(/status enum is `([a-z |]+)`/)
    assert.isNotNull(enumMatch, 'architecture.md must state the status enum as `a | b | ...`')
    const documented = new Set(
      (enumMatch![1] ?? '').split('|').map((s) => s.trim()).filter(Boolean)
    )
    const missing = TENANT_STATUSES.filter((s) => !documented.has(s))
    assert.deepEqual(
      missing,
      [],
      `these tenant statuses are missing from the architecture.md status enum: ${missing.join(', ')}`
    )
  })
})
