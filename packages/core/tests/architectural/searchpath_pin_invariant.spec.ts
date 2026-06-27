import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-1 / searchpath-pinned-per-connection-name.
 *
 * SchemaPgDriver.connect() has a fast path: when db.manager.has(name) is
 * already true it touches the LRU and returns the cached connection WITHOUT
 * verifying that connection's searchPath still points at this tenant's schema.
 * A name collision, a stale registration, or a prefix change would then serve
 * a connection scoped to a DIFFERENT tenant's schema. The robust fix asserts
 * the registered searchPath === [schemaName(tenant)] on that branch (throwing
 * IsolationConfigException on mismatch).
 *
 * This is an anti-regression lock so the per-name searchPath verification can
 * never be quietly dropped by a future refactor.
 *
 * RED (current code): the has(name) branch body contains no `searchPath`
 * reference.
 */

const DRIVER = fileURLToPath(
  new URL('../../src/services/isolation/schema_pg_driver.ts', import.meta.url)
)

/**
 * Extract the exact `{ ... }` block of the `if (db.manager.has(name)) { ... }`
 * fast path via brace matching, so the scan is scoped to the branch body and
 * cannot be fooled by the `db.manager.add(name, { searchPath })` that appears
 * later in connect().
 */
function fastPathBranch(src: string): string {
  // Anchor on the block-opening form `db.manager.has(name)) {` specifically,
  // so we land on connect()'s fast path and not the brace-less `release`
  // callback's `if (db.manager.has(name)) await ...`.
  const idx = src.indexOf('db.manager.has(name)) {')
  if (idx < 0) return ''
  const open = src.indexOf('{', idx)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ''
}

test.group(
  'Architectural: schema-pg connect() pins searchPath on the cached-connection fast path',
  () => {
    test('the db.manager.has(name) fast path verifies searchPath before returning a cached connection', ({
      assert,
    }) => {
      const src = readFileSync(DRIVER, 'utf8')
      const branch = fastPathBranch(src)
      assert.isNotEmpty(
        branch,
        'could not locate the db.manager.has(name) fast path in schema_pg_driver.ts'
      )
      assert.match(
        branch,
        /searchPath/,
        [
          'The cached-connection fast path in SchemaPgDriver.connect() must verify the',
          'registered connection.searchPath matches schemaName(tenant) before returning it.',
          'Otherwise a name collision / stale registration / prefix change serves a',
          "connection scoped to another tenant's schema. Add the assertion (throwing",
          'IsolationConfigException on mismatch) to the has(name) branch.',
        ].join(' ')
      )
    })

    test('detector controls: matches a guarded branch, ignores an unguarded one', ({ assert }) => {
      const guarded =
        'if (db.manager.has(name)) {\n' +
        '  const existing = db.manager.get(name)?.config as any\n' +
        '  if (existing?.searchPath?.[0] !== this.schemaName(tenant)) throw new IsolationConfigException("x")\n' +
        '  this.#lru.touch(name)\n' +
        '  return db.connection(name)\n' +
        '}'
      const unguarded =
        'if (db.manager.has(name)) {\n' +
        '  this.#lru.touch(name)\n' +
        '  return db.connection(name)\n' +
        '}'

      assert.match(
        fastPathBranch(guarded),
        /searchPath/,
        'must flag the guarded branch as compliant'
      )
      assert.notMatch(
        fastPathBranch(unguarded),
        /searchPath/,
        'must flag the unguarded branch as a violation'
      )
    })
  }
)
