import { test } from '@japa/runner'
import {
  setTenantRlsGuc,
  withTenantRls,
  DEFAULT_RLS_GUC,
  type RlsQueryRunner,
  type RlsTransactor,
} from '../../../../src/services/isolation/rls.js'

const TENANT = '11111111-1111-4111-8111-111111111111'

/** Records every rawQuery call so the test can assert the emitted SQL/bindings. */
function recordingRunner(): RlsQueryRunner & {
  calls: Array<{ sql: string; bindings?: any[] | undefined }>
} {
  const calls: Array<{ sql: string; bindings?: any[] | undefined }> = []
  return {
    calls,
    async rawQuery(sql: string, bindings?: any[]) {
      calls.push({ sql, bindings })
      return undefined
    },
  }
}

test.group('setTenantRlsGuc', () => {
  test('binds set_config with the default setting, transaction-local', async ({ assert }) => {
    const runner = recordingRunner()
    await setTenantRlsGuc(runner, TENANT)

    assert.lengthOf(runner.calls, 1)
    assert.equal(runner.calls[0]!.sql, 'select set_config(?, ?, ?)')
    assert.deepEqual(runner.calls[0]!.bindings, [DEFAULT_RLS_GUC, TENANT, true])
  })

  test('honours a custom setting name and is always transaction-local', async ({ assert }) => {
    const runner = recordingRunner()
    await setTenantRlsGuc(runner, TENANT, { gucName: 'tenancy.id' })

    // Third arg (is_local) is always true. There is no session-level mode.
    assert.deepEqual(runner.calls[0]!.bindings, ['tenancy.id', TENANT, true])
  })

  test('rejects an unsafe tenant id before touching the DB', async ({ assert }) => {
    const runner = recordingRunner()
    await assert.rejects(
      () => setTenantRlsGuc(runner, "x'; drop table users; --"),
      /Refusing to use unsafe tenant id/
    )
    assert.lengthOf(runner.calls, 0)
  })

  test('rejects a setting name that is not class.name', async ({ assert }) => {
    const runner = recordingRunner()
    await assert.rejects(
      () => setTenantRlsGuc(runner, TENANT, { gucName: 'noclass' }),
      /Refusing to use unsafe RLS setting name/
    )
    assert.lengthOf(runner.calls, 0)
  })
})

test.group('withTenantRls', () => {
  test('opens a transaction, sets the setting first, then runs fn with the trx', async ({
    assert,
  }) => {
    const order: string[] = []
    const trx: RlsQueryRunner = {
      async rawQuery(sql: string, bindings?: any[]) {
        order.push(`set:${bindings?.[0]}=${bindings?.[1]}`)
        return undefined
      },
    }
    const transactor: RlsTransactor = {
      async transaction(callback) {
        order.push('begin')
        const result = await callback(trx)
        order.push('commit')
        return result
      },
    }

    const result = await withTenantRls(
      TENANT,
      async (handed) => {
        order.push('fn')
        assert.strictEqual(handed, trx, 'fn receives the same trx the setting was set on')
        return 'ok'
      },
      { transactor }
    )

    assert.equal(result, 'ok')
    assert.deepEqual(order, ['begin', `set:${DEFAULT_RLS_GUC}=${TENANT}`, 'fn', 'commit'])
  })

  test('propagates fn errors so the transaction rolls back', async ({ assert }) => {
    let rolledBack = false
    const transactor: RlsTransactor = {
      async transaction(callback) {
        try {
          return await callback({
            async rawQuery() {
              return undefined
            },
          })
        } catch (error) {
          rolledBack = true
          throw error
        }
      },
    }

    await assert.rejects(
      () =>
        withTenantRls(
          TENANT,
          async () => {
            throw new Error('boom')
          },
          { transactor }
        ),
      /boom/
    )
    assert.isTrue(rolledBack)
  })
})
