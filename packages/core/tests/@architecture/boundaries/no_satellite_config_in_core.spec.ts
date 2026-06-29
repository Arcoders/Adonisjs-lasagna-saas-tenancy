import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { MultitenancyConfig } from '../../../src/types/config.js'

/**
 * WS-7 / satellite-config-frozen-into-core.
 *
 * Core's public `MultitenancyConfig` is frozen at 1.0. It must NOT bake in
 * satellite-specific config blocks (`billing`, `backup`) or the satellite-owned
 * `BillingConfig` / `BillingDriverChoice` types — a host that never installs
 * those satellites would otherwise carry their shapes in its frozen core type,
 * and the satellites could never evolve their config without a core release. The
 * blocks are now contributed by each satellite via `SatelliteConfigRegistry`
 * declaration merging (see packages/billing|backup/src/define_config.ts).
 *
 * RED (pre-fix): config.ts declared `billing?: BillingConfig` + a `backup?` block
 * and re-exported `BillingConfig` / `BillingDriverChoice`.
 */
const CONFIG_TS = fileURLToPath(new URL('../../../src/types/config.ts', import.meta.url))
const TYPES_INDEX = fileURLToPath(new URL('../../../src/types/index.ts', import.meta.url))

test.group('architectural — no satellite config frozen into core', () => {
  test('core config.ts declares no billing/backup block and no BillingConfig type', ({
    assert,
  }) => {
    const src = readFileSync(CONFIG_TS, 'utf8')
    assert.notMatch(src, /^\s*billing\?:/m, 'config.ts must not declare a `billing?` field')
    assert.notMatch(src, /^\s*backup\?:\s*\{/m, 'config.ts must not declare a `backup?` block')
    assert.notMatch(
      src,
      /BillingConfig/,
      'config.ts must not reference BillingConfig (moved to billing)'
    )
    assert.notMatch(
      src,
      /BillingDriverChoice/,
      'config.ts must not reference BillingDriverChoice (moved to billing)'
    )
  })

  test('core types barrel does not re-export the satellite-owned billing types', ({ assert }) => {
    const src = readFileSync(TYPES_INDEX, 'utf8')
    assert.notMatch(src, /BillingConfig/, 'types/index.ts must not re-export BillingConfig')
    assert.notMatch(
      src,
      /BillingDriverChoice/,
      'types/index.ts must not re-export BillingDriverChoice'
    )
  })

  test('the open SatelliteConfigRegistry seam is present (the re-homing mechanism)', ({
    assert,
  }) => {
    const src = readFileSync(CONFIG_TS, 'utf8')
    assert.match(
      src,
      /export interface SatelliteConfigRegistry\b/,
      'config.ts must declare the open SatelliteConfigRegistry interface'
    )
    assert.match(
      src,
      /interface MultitenancyConfig extends SatelliteConfigRegistry\b/,
      'MultitenancyConfig must extend SatelliteConfigRegistry'
    )
  })

  test('compile-time: billing/backup are NOT keys of core MultitenancyConfig', ({ assert }) => {
    // Core's own compilation has no satellite augmentation, so neither key is on
    // the type. These conditional types resolve to `false`; if a future edit
    // re-adds the field to core, the assignment stops compiling (caught by
    // `npm run typecheck`), not just at runtime.
    type HasBilling = 'billing' extends keyof MultitenancyConfig ? true : false
    type HasBackup = 'backup' extends keyof MultitenancyConfig ? true : false
    const billingIsCoreKey: HasBilling = false
    const backupIsCoreKey: HasBackup = false
    assert.isFalse(billingIsCoreKey)
    assert.isFalse(backupIsCoreKey)
  })

  test('detector control: the matchers would catch a reintroduced field', ({ assert }) => {
    assert.match('  billing?: BillingConfig', /^\s*billing\?:/m)
    assert.match('  backup?: {', /^\s*backup\?:\s*\{/m)
    assert.notMatch('  cache: {', /^\s*billing\?:/m)
  })
})
