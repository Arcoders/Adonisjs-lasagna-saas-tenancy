import { test } from '@japa/runner'
import PluginDoctorService, {
  type PluginDoctorInput,
  type PluginDoctorSatellite,
} from '../../../../src/services/plugin_doctor_service.js'

/**
 * The plugin platform doctor (S6). Pure: it maps installed satellite manifests + the
 * runtime trust/firewall posture to actionable diagnoses. Each check is exercised in
 * isolation, plus the all-clear path and the severity totals.
 */

const CORE_API = 3

function sat(over: Partial<PluginDoctorSatellite> = {}): PluginDoctorSatellite {
  return { packageName: '@x/plugin', name: 'plugin', satelliteApi: CORE_API, ...over }
}

function run(over: Partial<PluginDoctorInput> = {}) {
  return new PluginDoctorService().run({
    satellites: [],
    trusted: [],
    readOnlyConfigured: true,
    coreSatelliteApi: CORE_API,
    ...over,
  })
}

const codes = (r: { issues: readonly { code: string }[] }) => r.issues.map((i) => i.code)
const sev = (r: { issues: readonly { code: string; severity: string }[] }, code: string) =>
  r.issues.find((i) => i.code === code)?.severity

test.group('PluginDoctorService — ABI compatibility', () => {
  test('a satellite needing a NEWER ABI is an error', ({ assert }) => {
    const r = run({ satellites: [sat({ satelliteApi: CORE_API + 1 })] })
    assert.include(codes(r), 'plugin_abi_incompatible')
    assert.equal(r.totals.error, 1)
  })

  test('an OLDER or undeclared ABI is a warning', ({ assert }) => {
    const older = run({ satellites: [sat({ satelliteApi: CORE_API - 1 })] })
    assert.equal(sev(older, 'plugin_abi_unverified'), 'warn')
    const undeclared = run({ satellites: [sat({ satelliteApi: undefined })] })
    assert.equal(sev(undeclared, 'plugin_abi_unverified'), 'warn')
  })

  test('an exactly-matching ABI raises no ABI issue', ({ assert }) => {
    const r = run({ satellites: [sat({ satelliteApi: CORE_API })] })
    assert.notInclude(codes(r), 'plugin_abi_incompatible')
    assert.notInclude(codes(r), 'plugin_abi_unverified')
  })
})

test.group('PluginDoctorService — native addons', () => {
  test('a native-addon satellite is warned (not sandboxable)', ({ assert }) => {
    const r = run({ satellites: [sat({ nativeAddons: true })], trusted: ['plugin'] })
    assert.include(codes(r), 'plugin_native_addons')
  })

  test('a satellite without native addons is not flagged', ({ assert }) => {
    const r = run({ satellites: [sat({ nativeAddons: false })], trusted: ['plugin'] })
    assert.notInclude(codes(r), 'plugin_native_addons')
  })
})

test.group('PluginDoctorService — trust allowlist', () => {
  test('a TRUSTED_SATELLITES entry matching no installed satellite is a dead entry', ({
    assert,
  }) => {
    const r = run({ satellites: [sat({ name: 'reporting' })], trusted: ['reporting', 'typo'] })
    assert.equal(sev(r, 'plugin_trust_dead_entry'), 'warn')
    // Only the unmatched entry is flagged.
    assert.equal(r.issues.filter((i) => i.code === 'plugin_trust_dead_entry').length, 1)
  })

  test('every trusted entry matching an installed satellite raises no dead-entry issue', ({
    assert,
  }) => {
    const r = run({ satellites: [sat({ name: 'reporting' })], trusted: ['reporting'] })
    assert.notInclude(codes(r), 'plugin_trust_dead_entry')
  })
})

test.group('PluginDoctorService — read-only firewall posture', () => {
  test('untrusted satellites without plugins.readOnly is a warning', ({ assert }) => {
    const r = run({
      satellites: [sat({ name: 'sketchy' })],
      trusted: [],
      readOnlyConfigured: false,
    })
    assert.equal(sev(r, 'plugin_read_only_unconfigured'), 'warn')
  })

  test('configured read-only firewall suppresses the warning', ({ assert }) => {
    const r = run({
      satellites: [sat({ name: 'sketchy' })],
      trusted: [],
      readOnlyConfigured: true,
    })
    assert.notInclude(codes(r), 'plugin_read_only_unconfigured')
  })

  test('all-trusted satellites need no read-only firewall', ({ assert }) => {
    const r = run({
      satellites: [sat({ name: 'reporting' })],
      trusted: ['reporting'],
      readOnlyConfigured: false,
    })
    assert.notInclude(codes(r), 'plugin_read_only_unconfigured')
  })

  test('no satellites at all raises no firewall warning', ({ assert }) => {
    const r = run({ satellites: [], readOnlyConfigured: false })
    assert.notInclude(codes(r), 'plugin_read_only_unconfigured')
  })
})

test.group('PluginDoctorService — declared permission disclosure', () => {
  test('EVERY declared (consent-gated) permission kind is disclosed as info', ({ assert }) => {
    // All four kinds are sensitive per the permission model — scheduler and
    // data_change must NOT be silently dropped from the audit.
    for (const perms of [
      ['db:write', 'network:external'],
      ['scheduler', 'data_change:User'],
    ]) {
      const r = run({
        satellites: [sat({ name: 'reporting', permissions: perms })],
        trusted: ['reporting'],
      })
      const issue = r.issues.find((i) => i.code === 'plugin_declared_permissions')
      assert.isDefined(issue, `expected disclosure for ${perms.join(',')}`)
      assert.equal(issue?.severity, 'info')
      // The message lists every declared permission, not a subset.
      for (const p of perms) assert.include(issue?.message ?? '', p)
    }
  })

  test('a satellite with no declared permissions raises no disclosure', ({ assert }) => {
    const r = run({ satellites: [sat({ name: 'reporting' })], trusted: ['reporting'] })
    assert.notInclude(codes(r), 'plugin_declared_permissions')
  })
})

test.group('PluginDoctorService — all-clear + totals', () => {
  test('a clean posture yields a single info all-clear', ({ assert }) => {
    const r = run({ satellites: [sat({ name: 'reporting' })], trusted: ['reporting'] })
    assert.deepEqual(codes(r), ['plugin_platform_ok'])
    assert.equal(r.totals.info, 1)
    assert.equal(r.totals.warn, 0)
    assert.equal(r.totals.error, 0)
  })

  test('totals count every severity across checks', ({ assert }) => {
    const r = run({
      satellites: [
        sat({ packageName: '@x/a', name: 'a', satelliteApi: CORE_API + 1 }), // error
        sat({ packageName: '@x/b', name: 'b', nativeAddons: true }), // warn
        sat({ packageName: '@x/c', name: 'c', permissions: ['db:write'] }), // info
      ],
      trusted: ['a', 'b', 'c'],
      readOnlyConfigured: true,
    })
    assert.equal(r.totals.error, 1)
    assert.isAtLeast(r.totals.warn, 1)
    assert.isAtLeast(r.totals.info, 1)
  })
})
