import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getConfig, __resetConfigForTests } from '../../src/config.js'
import { setupTestConfig } from '../helpers/config.js'

/**
 * WS-10 / getconfig-preboot-trap-not-in-gotchas.
 *
 * `getConfig()` throws before the provider's `boot()` calls `setConfig()` — a
 * real load-order trap (top-level call, or a unit test that never booted). The
 * gotchas page must document it. This test anchors the behavior AND pins the doc.
 *
 * RED (pre-fix): gotchas.md had no getConfig() entry.
 */
const GOTCHAS = fileURLToPath(new URL('../../../../docs/reference/gotchas.md', import.meta.url))

test.group('architectural — getConfig pre-boot trap is documented', () => {
  test('getConfig() throws before the config is set (the documented behavior)', ({ assert }) => {
    __resetConfigForTests()
    try {
      assert.throws(() => getConfig())
    } finally {
      // Restore a sane config so later tests sharing the singleton are unaffected.
      setupTestConfig()
    }
  })

  test('gotchas.md documents the getConfig() pre-boot trap', ({ assert }) => {
    const text = readFileSync(GOTCHAS, 'utf8')
    assert.match(text, /getConfig\(\)/, 'gotchas.md must mention getConfig()')
    assert.match(text, /before .*boot|pre-boot|provider boots/i, 'and explain the pre-boot trap')
  })
})
