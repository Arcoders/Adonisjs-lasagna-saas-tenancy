import { test } from '@japa/runner'
import {
  GUARANTEES,
  guaranteeGlobs,
  guaranteeTag,
  isGuarantee,
  resolveSuiteGlobs,
} from '../../src/guarantees.js'

test.group('GUARANTEES taxonomy', () => {
  test('is the canonical, non-empty set', ({ assert }) => {
    assert.deepEqual(
      [...GUARANTEES],
      ['isolation', 'security', 'behavior', 'resilience', 'performance']
    )
  })

  test('isGuarantee narrows known and rejects unknown', ({ assert }) => {
    assert.isTrue(isGuarantee('isolation'))
    assert.isTrue(isGuarantee('performance'))
    assert.isFalse(isGuarantee('isolaton'))
    assert.isFalse(isGuarantee('e2e'))
  })

  test('guaranteeTag prefixes with @', ({ assert }) => {
    assert.equal(guaranteeTag('security'), '@security')
  })
})

test.group('guaranteeGlobs', () => {
  test('unit excludes architecture by default and includes it when asked', ({ assert }) => {
    assert.deepEqual(guaranteeGlobs().unit, ['tests/@guarantees/**/unit/**/*.spec.ts'])
    assert.deepEqual(guaranteeGlobs({ withArchitecture: true }).unit, [
      'tests/@guarantees/**/unit/**/*.spec.ts',
      'tests/@architecture/**/*.spec.ts',
    ])
  })

  test('integration defaults to guarantees + the drivers dir, gating-only (no fault)', ({
    assert,
  }) => {
    assert.deepEqual(guaranteeGlobs().integration, [
      'tests/@guarantees/**/integration/**/*.spec.ts',
      'tests/@integration/drivers/**/*.spec.ts',
    ])
  })

  test('integrationDirs is overridable', ({ assert }) => {
    assert.deepEqual(guaranteeGlobs({ integrationDirs: ['drivers', 'wire'] }).integration, [
      'tests/@guarantees/**/integration/**/*.spec.ts',
      'tests/@integration/drivers/**/*.spec.ts',
      'tests/@integration/wire/**/*.spec.ts',
    ])
  })

  test('fault is the chaos tier only, with an overridable dir', ({ assert }) => {
    assert.deepEqual(guaranteeGlobs().fault, ['tests/@integration/fault_injection/**/*.spec.ts'])
    assert.deepEqual(guaranteeGlobs({ faultDir: 'chaos' }).fault, [
      'tests/@integration/chaos/**/*.spec.ts',
    ])
  })

  test('guarantee(category) splits by harness leaf', ({ assert }) => {
    assert.deepEqual(guaranteeGlobs().guarantee('isolation'), {
      unit: ['tests/@guarantees/isolation/unit/**/*.spec.ts'],
      integration: ['tests/@guarantees/isolation/integration/**/*.spec.ts'],
    })
  })
})

test.group('resolveSuiteGlobs', () => {
  test('is the identity with no filter', ({ assert }) => {
    const globs = ['tests/@guarantees/**/integration/**/*.spec.ts']
    assert.deepEqual(resolveSuiteGlobs({ suiteGlobs: globs }), globs)
    assert.deepEqual(resolveSuiteGlobs({ suiteGlobs: globs, guaranteeFilter: [] }), globs)
  })

  test('narrows to the filtered guarantees integration leaves', ({ assert }) => {
    assert.deepEqual(
      resolveSuiteGlobs({ suiteGlobs: ['ignored'], guaranteeFilter: ['isolation', 'security'] }),
      [
        'tests/@guarantees/isolation/integration/**/*.spec.ts',
        'tests/@guarantees/security/integration/**/*.spec.ts',
      ]
    )
  })

  test('rejects an unknown guarantee loudly', ({ assert }) => {
    assert.throws(
      () => resolveSuiteGlobs({ suiteGlobs: [], guaranteeFilter: ['isolaton'] }),
      /unknown guarantee\(s\) isolaton/
    )
  })
})
