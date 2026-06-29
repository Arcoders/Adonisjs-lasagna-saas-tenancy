import { test } from '@japa/runner'
import { readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { GUARANTEES } from '../../../../satellite-test-kit/src/guarantees.js'

/**
 * Anti-drift guard for the guarantee-oriented test tree. The guarantee a spec
 * belongs to is encoded in its PATH (`tests/@guarantees/<g>/<harness>/`), and
 * the runners + `test:guarantee` filter on that path, so a typo'd guarantee
 * directory (`@guarantees/isolaton/`) would silently fall out of every
 * guarantee view. This pins the directory layout against the single-source
 * taxonomy in the kit, so adding a guarantee means editing GUARANTEES (one
 * place) and creating the matching directory — nothing else can drift.
 *
 * Reads directories only (no Ignitor, no DB), so it runs in the unit harness
 * alongside the other source-walk architectural specs.
 */

const GUARANTEES_DIR = fileURLToPath(new URL('../../@guarantees', import.meta.url))
const HARNESS_LEAVES = ['unit', 'integration']

test.group('Architecture: guarantee tree', () => {
  test('every directory under tests/@guarantees is a known guarantee', ({ assert }) => {
    const dirs = readdirSync(GUARANTEES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
    const unknown = dirs.filter((d) => !(GUARANTEES as readonly string[]).includes(d))
    assert.deepEqual(
      unknown,
      [],
      `Directories under tests/@guarantees/ that are not in GUARANTEES (typo, or add it to the taxonomy): ${unknown.join(', ')}`
    )
  })

  test('each guarantee holds only unit/ and integration/ harness leaves', ({ assert }) => {
    for (const guarantee of GUARANTEES) {
      const dir = fileURLToPath(new URL(`../../@guarantees/${guarantee}`, import.meta.url))
      if (!existsSync(dir)) continue // a guarantee with no specs yet is fine
      const leaves = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
      const bad = leaves.filter((l) => !HARNESS_LEAVES.includes(l))
      assert.deepEqual(
        bad,
        [],
        `@guarantees/${guarantee} has non-harness directories: ${bad.join(', ')}`
      )
    }
  })
})
