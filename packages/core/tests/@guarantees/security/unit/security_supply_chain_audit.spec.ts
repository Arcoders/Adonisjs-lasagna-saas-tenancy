import { test } from '@japa/runner'
import {
  parseNpmAudit,
  countAtOrAbove,
  hasInstallScripts,
} from '../../../../src/services/supply_chain_audit.js'

/**
 * The pure logic behind `lasagna:health-check` (S2). The command shells `npm
 * audit` and reads satellite package.jsons; these functions turn that raw data
 * into a report + a fail/allow decision, so they carry the correctness that the
 * (untestable) command shell relies on.
 */

const SAMPLE_AUDIT = {
  vulnerabilities: {
    lodash: { severity: 'high', via: [{ title: 'Prototype Pollution', url: 'x' }] },
    minimist: { severity: 'critical', via: ['lodash'] },
    trim: { severity: 'low', via: [{ title: 'ReDoS' }] },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 1, moderate: 0, high: 1, critical: 1, total: 3 },
  },
}

test.group('supply-chain audit — parseNpmAudit', () => {
  test('reads the severity summary and per-package advisories', ({ assert }) => {
    const report = parseNpmAudit(SAMPLE_AUDIT)
    assert.equal(report.total, 3)
    assert.deepEqual(report.bySeverity, { info: 0, low: 1, moderate: 0, high: 1, critical: 1 })
    const lodash = report.advisories.find((a) => a.name === 'lodash')
    assert.equal(lodash?.severity, 'high')
    assert.equal(lodash?.title, 'Prototype Pollution')
    // a `via` that is a string reference (not an advisory object) yields no title
    assert.equal(report.advisories.find((a) => a.name === 'minimist')?.title, '')
  })

  test('is tolerant of an empty / partial object (returns zeros)', ({ assert }) => {
    const report = parseNpmAudit({})
    assert.equal(report.total, 0)
    assert.deepEqual(report.advisories, [])
    assert.equal(parseNpmAudit(null).total, 0)
    assert.equal(parseNpmAudit('nonsense').total, 0)
  })

  test('falls back to summing severities when metadata.total is absent', ({ assert }) => {
    const report = parseNpmAudit({ metadata: { vulnerabilities: { high: 2, low: 1 } } })
    assert.equal(report.total, 3)
  })
})

test.group('supply-chain audit — thresholds + install scripts', () => {
  test('countAtOrAbove counts only severities at or above the threshold', ({ assert }) => {
    const report = parseNpmAudit(SAMPLE_AUDIT)
    assert.equal(countAtOrAbove(report, 'high'), 2) // high + critical
    assert.equal(countAtOrAbove(report, 'critical'), 1)
    assert.equal(countAtOrAbove(report, 'low'), 3) // low + high + critical
  })

  test('hasInstallScripts flags pre/install/postinstall but not build scripts', ({ assert }) => {
    assert.isTrue(hasInstallScripts({ postinstall: 'node evil.js' }))
    assert.isTrue(hasInstallScripts({ preinstall: 'x' }))
    assert.isTrue(hasInstallScripts({ install: 'node-gyp rebuild' }))
    assert.isFalse(hasInstallScripts({ build: 'tsc', test: 'japa' }))
    assert.isFalse(hasInstallScripts({}))
    assert.isFalse(hasInstallScripts(undefined))
  })
})
