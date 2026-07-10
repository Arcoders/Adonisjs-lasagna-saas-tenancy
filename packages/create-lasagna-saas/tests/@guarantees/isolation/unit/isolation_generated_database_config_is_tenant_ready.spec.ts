import { test } from '@japa/runner'
import { databaseConfig, databaseName, envBlock } from '../../../../src/templates.js'

/**
 * `config/database.ts` is the file `configure` cannot write, and getting it
 * wrong does not fail loudly — it fails by routing every tenant's query to the
 * `public` schema. Two defects shipped in the install docs before these specs
 * existed, and both are pinned here:
 *
 *   - `searchPath` nested INSIDE `connection` instead of beside it
 *   - no `tenant` template connection for SchemaPgDriver to clone
 */

/** The body of a `name: { ... }` connection node, brace-matched from the source. */
function connectionNode(source: string, name: string): string {
  const start = source.indexOf(`${name}: {`)
  if (start === -1) throw new Error(`no connection named ${name} in the generated config`)

  let depth = 0
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++
    if (source[i] === '}') depth--
    if (depth === 0) return source.slice(start, i + 1)
  }
  throw new Error(`unbalanced braces in the ${name} connection node`)
}

test.group('Isolation: the generated database config routes per tenant', () => {
  test('it declares the three connection contexts the package documents', ({ assert }) => {
    const source = databaseConfig()

    for (const name of ['public', 'backoffice', 'tenant']) {
      assert.include(source, `${name}: {`, `the ${name} connection is missing`)
    }
  })

  test('the tenant template connection exists, or provisioning cannot clone it', ({ assert }) => {
    // SchemaPgDriver looks this up by name and dies with "template connection
    // not found" when it is absent. No doc mentioned it; installs died on it.
    assert.include(databaseConfig(), 'tenant: {')
  })

  test('searchPath sits beside connection, never nested inside it', ({ assert }) => {
    const source = databaseConfig()

    for (const name of ['public', 'backoffice', 'tenant']) {
      const node = connectionNode(source, name)
      assert.include(node, 'searchPath:', `${name} declares no searchPath`)

      const connection = node.indexOf('connection: baseConnection')
      const searchPath = node.indexOf('searchPath:')
      assert.isAbove(
        searchPath,
        connection,
        `${name}: searchPath must follow connection as a sibling key`
      )
      assert.notInclude(
        node,
        'connection: {',
        `${name}: the connection node must reference baseConnection, not inline an object that could swallow searchPath`
      )
    }
  })

  test('the backoffice connection owns the migration path', ({ assert }) => {
    const node = connectionNode(databaseConfig(), 'backoffice')

    assert.include(node, "paths: ['database/migrations']")
    assert.include(node, 'naturalSort: true')
  })

  test('only the backoffice connection runs migrations', ({ assert }) => {
    const source = databaseConfig()

    assert.notInclude(connectionNode(source, 'tenant'), 'migrations:')
    assert.notInclude(connectionNode(source, 'public'), 'migrations:')
  })
})

test.group('Isolation: the generated env block', () => {
  test('it names a database derived from the app directory', ({ assert }) => {
    assert.include(envBlock('my-saas'), 'DB_DATABASE=my_saas')
  })

  test('the database name is a legal unquoted postgres identifier', ({ assert }) => {
    assert.equal(databaseName('my-saas'), 'my_saas')
    assert.equal(databaseName('My.SaaS'), 'my_saas')
    assert.equal(databaseName('app--2'), 'app_2')
  })

  test('a leading digit is prefixed, because postgres rejects it unquoted', ({ assert }) => {
    assert.equal(databaseName('2fast'), 'app_2fast')
  })

  test('a name that normalises to nothing still yields an identifier', ({ assert }) => {
    assert.equal(databaseName('___'), 'app_')
  })

  test('it carries the redis keys the queue and cache bootstrappers read', ({ assert }) => {
    const block = envBlock('app')

    for (const key of ['QUEUE_REDIS_HOST', 'QUEUE_REDIS_PORT', 'CACHE_REDIS_HOST']) {
      assert.include(block, key)
    }
  })
})
