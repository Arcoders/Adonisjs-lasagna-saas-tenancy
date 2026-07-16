import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-1 / searchpath-pinned-per-connection-name.
 *
 * The pooled-driver `connect()` has a fast path: when db.manager.has(name) is
 * already true it touches the LRU and returns the cached connection. Serving it
 * WITHOUT verifying the connection is still pinned to this tenant's schema means
 * a name collision, a stale registration, or a prefix change would hand back a
 * connection scoped to a DIFFERENT tenant's schema. The robust fix asserts the
 * registered searchPath === schemaName(tenant) on that branch (throwing
 * IsolationConfigException on mismatch).
 *
 * After AD-05 the fast path lives on the shared {@link PooledPgDriver} base and
 * delegates the identity check to each driver's `verifyCachedConnection` hook, so
 * this anti-regression lock now checks TWO things: the base fast path calls the
 * hook, and schema-pg's hook keys the seal on `searchPath`. Neither can be
 * quietly dropped by a future refactor.
 */

const BASE = fileURLToPath(
  new URL('../../../src/services/isolation/pooled_pg_driver.ts', import.meta.url)
)
const SCHEMA_DRIVER = fileURLToPath(
  new URL('../../../src/services/isolation/schema_pg_driver.ts', import.meta.url)
)

/**
 * Extract the exact `{ ... }` block of the `if (db.manager.has(name)) { ... }`
 * fast path via brace matching, so the scan is scoped to the branch body and
 * cannot be fooled by the `db.manager.add(name, ...)` that appears later in
 * connect().
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

/** The body of the `protected verifyCachedConnection(...) { ... }` method. */
function verifyHookBody(src: string): string {
  const idx = src.indexOf('verifyCachedConnection(')
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
  'Architectural: pooled-pg connect() pins tenant identity on the cached-connection fast path',
  () => {
    test('the base fast path delegates the identity check to verifyCachedConnection', ({
      assert,
    }) => {
      const branch = fastPathBranch(readFileSync(BASE, 'utf8'))
      assert.isNotEmpty(
        branch,
        'could not locate the db.manager.has(name) fast path in pooled_pg_driver.ts'
      )
      assert.match(
        branch,
        /verifyCachedConnection/,
        [
          'The cached-connection fast path in PooledPgDriver.connect() must call the',
          'verifyCachedConnection hook before returning a cached connection, or a name',
          "collision / stale registration serves another tenant's connection.",
        ].join(' ')
      )
    })

    test('schema-pg verifyCachedConnection keys the seal on searchPath', ({ assert }) => {
      const body = verifyHookBody(readFileSync(SCHEMA_DRIVER, 'utf8'))
      assert.isNotEmpty(body, 'could not locate verifyCachedConnection in schema_pg_driver.ts')
      assert.match(
        body,
        /searchPath/,
        'schema-pg must verify the registered connection.searchPath matches schemaName(tenant).'
      )
      assert.match(
        body,
        /assertCachedConnectionIdentity/,
        'the check must route through the shared seal (assertCachedConnectionIdentity).'
      )
    })

    test('detector controls: matches a guarded fast path, ignores an unguarded one', ({
      assert,
    }) => {
      const guarded =
        'if (db.manager.has(name)) {\n' +
        '  this.verifyCachedConnection(tenant, db.manager.get(name)?.config, name)\n' +
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
        /verifyCachedConnection/,
        'must flag the guarded branch as compliant'
      )
      assert.notMatch(
        fastPathBranch(unguarded),
        /verifyCachedConnection/,
        'must flag the unguarded branch as a violation'
      )
    })
  }
)
