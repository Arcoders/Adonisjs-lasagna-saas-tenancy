import { test } from '@japa/runner'
import ComplianceReportService from '../../../../src/services/compliance/compliance_report_service.js'
import type {
  ComplianceContext,
  ComplianceControl,
  ControlStatus,
} from '../../../../src/services/compliance/types.js'
import { testConfig } from '../../../helpers/config.js'

const fakeCtx: ComplianceContext = { config: testConfig, db: {} as any }

function control(
  id: string,
  frameworks: string[],
  status: ControlStatus = 'satisfied'
): ComplianceControl {
  return {
    id,
    title: `Title ${id}`,
    frameworks,
    detect: () => ({ status, evidence: `ev ${id}`, hostResponsibility: `host ${id}` }),
  }
}

test.group('ComplianceReportService — registry', () => {
  test('register/unregister/has/list reflect current state', ({ assert }) => {
    const svc = new ComplianceReportService()
    assert.lengthOf(svc.list(), 0)
    svc.register(control('a', ['soc2:CC6.1']))
    svc.register(control('b', ['gdpr:art17']))
    assert.lengthOf(svc.list(), 2)
    assert.isTrue(svc.has('a'))
    svc.unregister('a')
    assert.isFalse(svc.has('a'))
    assert.lengthOf(svc.list(), 1)
  })

  test('register overwrites a control with the same id', ({ assert }) => {
    const svc = new ComplianceReportService()
    svc.register(control('x', ['soc2:CC6.1']))
    svc.register(control('x', ['gdpr:art17']))
    assert.lengthOf(svc.list(), 1)
    assert.deepEqual(svc.list()[0]!.frameworks, ['gdpr:art17'])
  })
})

test.group('ComplianceReportService — run()', () => {
  test('merges id/title/frameworks into each result', async ({ assert }) => {
    const svc = new ComplianceReportService()
    svc.register(control('iso', ['iso:A.8.15']))
    const report = await svc.run({}, fakeCtx)
    assert.deepEqual(report.controls[0], {
      id: 'iso',
      title: 'Title iso',
      frameworks: ['iso:A.8.15'],
      status: 'satisfied',
      evidence: 'ev iso',
      hostResponsibility: 'host iso',
    })
  })

  test('--framework filters by the token prefix', async ({ assert }) => {
    const svc = new ComplianceReportService()
    svc.register(control('a', ['soc2:CC6.1', 'gdpr:art32']))
    svc.register(control('b', ['gdpr:art17']))
    svc.register(control('c', ['hipaa:164.312(b)']))

    const gdpr = await svc.run({ framework: 'gdpr' }, fakeCtx)
    assert.deepEqual(gdpr.controls.map((c) => c.id).sort(), ['a', 'b'])

    const hipaa = await svc.run({ framework: 'hipaa' }, fakeCtx)
    assert.deepEqual(
      hipaa.controls.map((c) => c.id),
      ['c']
    )

    const all = await svc.run({ framework: 'all' }, fakeCtx)
    assert.lengthOf(all.controls, 3)
  })

  test('--control runs only the named control(s)', async ({ assert }) => {
    const svc = new ComplianceReportService()
    svc.register(control('a', ['soc2:CC6.1']))
    svc.register(control('b', ['gdpr:art17']))
    const report = await svc.run({ controls: ['b'] }, fakeCtx)
    assert.deepEqual(
      report.controls.map((c) => c.id),
      ['b']
    )
  })

  test('a throwing control is recorded as action-needed and does not abort', async ({ assert }) => {
    const svc = new ComplianceReportService()
    svc.register({
      id: 'boom',
      title: 'Boom',
      frameworks: ['soc2:CC6.1'],
      detect: () => {
        throw new Error('kaboom')
      },
    })
    svc.register(control('after', ['soc2:CC6.1']))
    const report = await svc.run({}, fakeCtx)
    assert.equal(report.controls[0]!.status, 'action-needed')
    assert.match(report.controls[0]!.evidence, /kaboom/)
    assert.equal(report.controls[1]!.id, 'after')
  })

  test('aggregates totals by status', async ({ assert }) => {
    const svc = new ComplianceReportService()
    svc.register(control('s', ['soc2:CC6.1'], 'satisfied'))
    svc.register(control('a', ['soc2:CC6.1'], 'action-needed'))
    svc.register(control('i', ['soc2:CC6.1'], 'info'))
    const report = await svc.run({}, fakeCtx)
    assert.deepEqual(report.totals, { satisfied: 1, actionNeeded: 1, info: 1 })
  })

  test('result survives a JSON round-trip', async ({ assert }) => {
    const svc = new ComplianceReportService()
    svc.register(control('a', ['soc2:CC6.1']))
    const report = await svc.run({}, fakeCtx)
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report)
  })
})
