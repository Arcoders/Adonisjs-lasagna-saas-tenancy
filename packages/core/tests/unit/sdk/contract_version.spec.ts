import { test } from '@japa/runner'
import {
  compareContractVersion,
  checkContractCompat,
  assertContractCompat,
} from '../../../src/sdk/contract_version.js'
import * as sdk from '../../../src/sdk/index.js'

test.group('sdk — compareContractVersion', () => {
  test('equal → ok', ({ assert }) => {
    assert.equal(compareContractVersion(2, 2), 'ok')
  })
  test('declared newer than surface → fail', ({ assert }) => {
    assert.equal(compareContractVersion(3, 2), 'fail')
  })
  test('declared older than surface → warn', ({ assert }) => {
    assert.equal(compareContractVersion(1, 2), 'warn')
  })
  test('absent → warn', ({ assert }) => {
    assert.equal(compareContractVersion(undefined, 2), 'warn')
  })
})

test.group('sdk — checkContractCompat', () => {
  test('equal → ok (no message)', ({ assert }) => {
    assert.deepEqual(checkContractCompat(1, 1, 'demo'), { level: 'ok' })
  })

  test('newer → fail, message names the offender and both versions', ({ assert }) => {
    const r = checkContractCompat(3, 2, 'top_props')
    assert.equal(r.level, 'fail')
    assert.match((r as any).message, /top_props/)
    assert.match((r as any).message, /contract v3/)
    assert.match((r as any).message, /provides v2/)
  })

  test('older → warn (proceeds, degraded)', ({ assert }) => {
    const r = checkContractCompat(1, 2, 'top_props')
    assert.equal(r.level, 'warn')
    assert.match((r as any).message, /built for extension contract v1/)
  })

  test('absent → warn (unversioned)', ({ assert }) => {
    const r = checkContractCompat(undefined, 2, 'top_props')
    assert.equal(r.level, 'warn')
    assert.match((r as any).message, /does not declare a contractVersion/)
  })
})

test.group('sdk — assertContractCompat', () => {
  test('fail → throws with the message', ({ assert }) => {
    assert.throws(() => assertContractCompat(3, 2, 'x'), /requires extension contract v3/)
  })

  test('warn → does NOT throw, routes the message to onWarn', ({ assert }) => {
    const warnings: string[] = []
    assert.doesNotThrow(() => assertContractCompat(1, 2, 'x', (m) => warnings.push(m)))
    assert.lengthOf(warnings, 1)
    assert.match(warnings[0], /built for extension contract v1/)
  })

  test('absent → warns, does not throw', ({ assert }) => {
    const warnings: string[] = []
    assertContractCompat(undefined, 2, 'x', (m) => warnings.push(m))
    assert.lengthOf(warnings, 1)
  })

  test('ok → neither throws nor warns', ({ assert }) => {
    const warnings: string[] = []
    assert.doesNotThrow(() => assertContractCompat(2, 2, 'x', (m) => warnings.push(m)))
    assert.lengthOf(warnings, 0)
  })
})

test.group('sdk — contract_version is on the /sdk public surface', () => {
  test('exposes the comparator + check + assert helpers', ({ assert }) => {
    assert.isFunction(sdk.compareContractVersion)
    assert.isFunction(sdk.checkContractCompat)
    assert.isFunction(sdk.assertContractCompat)
  })
})
