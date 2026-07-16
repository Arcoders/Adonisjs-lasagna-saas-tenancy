import { test } from '@japa/runner'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveOrderedSpecFiles } from '../../../../src/spec_order.js'

/**
 * The deterministic-order helper underpins reproducible runs: japa's fast-glob
 * discovery is unordered, so without this the run order depends on the directory
 * tree shape. These build a temp tree whose readdir order is not alphabetical and
 * assert the helper returns a stable, sorted set of file URLs.
 */
test.group('resolveOrderedSpecFiles', () => {
  test('returns matched specs sorted by path, as file URLs', async ({ assert }) => {
    const root = mkdtempSync(join(tmpdir(), 'lasagna-order-'))
    try {
      // Create in a deliberately non-alphabetical creation order.
      mkdirSync(join(root, 'tests/zeta'), { recursive: true })
      mkdirSync(join(root, 'tests/alpha'), { recursive: true })
      writeFileSync(join(root, 'tests/zeta/z_two.spec.ts'), '')
      writeFileSync(join(root, 'tests/alpha/a_one.spec.ts'), '')
      writeFileSync(join(root, 'tests/alpha/a_two.spec.ts'), '')
      writeFileSync(join(root, 'tests/alpha/not_a_spec.ts'), '') // must be ignored

      const urls = await resolveOrderedSpecFiles(['tests/**/*.spec.ts'], root)
      const rel = urls.map((u) => fileURLToPath(u).replace(root, '').replace(/\\/g, '/'))

      assert.deepEqual(rel, [
        '/tests/alpha/a_one.spec.ts',
        '/tests/alpha/a_two.spec.ts',
        '/tests/zeta/z_two.spec.ts',
      ])
      assert.isTrue(urls.every((u) => u instanceof URL && u.protocol === 'file:'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('honours the ignore patterns', async ({ assert }) => {
    const root = mkdtempSync(join(tmpdir(), 'lasagna-order-'))
    try {
      mkdirSync(join(root, 'tests/keep'), { recursive: true })
      mkdirSync(join(root, 'tests/skip'), { recursive: true })
      writeFileSync(join(root, 'tests/keep/k.spec.ts'), '')
      writeFileSync(join(root, 'tests/skip/s.spec.ts'), '')

      const urls = await resolveOrderedSpecFiles(['tests/**/*.spec.ts'], root, ['**/skip/**'])
      const rel = urls.map((u) => fileURLToPath(u).replace(root, '').replace(/\\/g, '/'))
      assert.deepEqual(rel, ['/tests/keep/k.spec.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
