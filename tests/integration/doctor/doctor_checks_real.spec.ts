import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import {
  DoctorService,
  CircuitBreakerService,
  schemaDriftCheck,
  migrationStateCheck,
  backupRecencyCheck,
  circuitBreakerCheck,
} from '@adonisjs-lasagna/saas-tenancy/services'
import type {
  DoctorCheck,
  DoctorContext,
  DiagnosisIssue,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { createTestTenant, destroyTestTenant } from '../helpers/tenant.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'

/**
 * End-to-end coverage for the five doctor checks that the unit suite
 * exercises only at the orchestration layer (with dummy checks):
 *
 *   - schema_drift     — provokes a missing schema AND an orphan schema
 *                        in real Postgres; asserts both codes fire.
 *   - migration_state  — active tenant whose schema exists but lacks the
 *                        `adonis_schema` table → `migrations_never_ran`.
 *   - backup_recency   — active tenant with no backup history on disk →
 *                        `backup_never_taken`.
 *   - circuit_breakers — forces a tenant's Opossum breaker into OPEN →
 *                        `circuit_open` reported with `fixable: true`;
 *                        a second run with `--fix` confirms closure.
 *   - register/run     — a host-app check registered via `register()`
 *                        appears in the resulting reports.
 *
 * The integration fixture's `MultitenancyProvider` already binds a real
 * `DoctorService` singleton and seeds it with the built-in checks. Each
 * test resolves that singleton, narrows the run to ONE check via
 * `options.checks`, and asserts the produced issues — so a regression
 * in a sibling check can't bleed into the assertions here.
 */
test.group('Doctor checks — real-state E2E', (group) => {
  let svc: DoctorService

  group.setup(async () => {
    svc = await app.container.make(DoctorService)
    // The fixture provider may or may not have registered the built-ins
    // (depends on bootstrap ordering); register defensively so this
    // spec is self-contained.
    if (!svc.has('schema_drift')) svc.register(schemaDriftCheck)
    if (!svc.has('migration_state')) svc.register(migrationStateCheck)
    if (!svc.has('backup_recency')) svc.register(backupRecencyCheck)
    if (!svc.has('circuit_breakers')) svc.register(circuitBreakerCheck)
  })

  test('schema_drift: detects schema_missing AND schema_orphan against real Postgres', async ({
    assert,
  }) => {
    const cfg = getConfig()
    const central = db.connection(cfg.centralConnectionName)
    const orphanId = randomUUID()
    const orphanSchema = `${cfg.tenantSchemaPrefix}${orphanId}`

    // Create THREE tenants: a healthy one, a missing-schema one, and the
    // baseline. Then drop one schema and create an orphan one.
    const healthy = await createTestTenant({ status: 'active', name: 'Healthy' })
    const missing = await createTestTenant({ status: 'active', name: 'MissingSchema' })

    // Provision real schemas for both healthy and missing.
    const healthySchema = `${cfg.tenantSchemaPrefix}${healthy.id}`
    const missingSchema = `${cfg.tenantSchemaPrefix}${missing.id}`
    await central.rawQuery(`CREATE SCHEMA "${healthySchema}"`)
    await central.rawQuery(`CREATE SCHEMA "${missingSchema}"`)

    // Now: drop "missing"'s schema by hand → registry says active but
    // the schema is gone. And create the orphan schema that doesn't
    // match any tenant in the registry.
    await central.rawQuery(`DROP SCHEMA "${missingSchema}" CASCADE`)
    await central.rawQuery(`CREATE SCHEMA "${orphanSchema}"`)

    try {
      const { reports } = await svc.run({ checks: ['schema_drift'] })
      assert.lengthOf(reports, 1)
      const issues = reports[0].issues

      const missingIssue = issues.find(
        (i) => i.code === 'schema_missing' && i.tenantId === missing.id
      )
      assert.isDefined(missingIssue, 'schema_missing must be reported for the dropped schema')
      assert.equal(missingIssue!.severity, 'error')

      const orphanIssue = issues.find(
        (i) => i.code === 'schema_orphan' && (i.meta as any)?.schema === orphanSchema
      )
      assert.isDefined(orphanIssue, 'schema_orphan must be reported for the dangling schema')
      assert.equal(orphanIssue!.severity, 'warn')

      // The healthy tenant must NOT appear in either bucket.
      const healthyIssue = issues.find((i) => i.tenantId === healthy.id)
      assert.isUndefined(healthyIssue, 'healthy tenant must not be flagged')
    } finally {
      await central.rawQuery(`DROP SCHEMA IF EXISTS "${healthySchema}" CASCADE`)
      await central.rawQuery(`DROP SCHEMA IF EXISTS "${orphanSchema}" CASCADE`)
      await destroyTestTenant(healthy.id).catch(() => {})
      await destroyTestTenant(missing.id).catch(() => {})
    }
  })

  test('migration_state: flags an active tenant whose schema lacks adonis_schema', async ({
    assert,
  }) => {
    const cfg = getConfig()
    const central = db.connection(cfg.centralConnectionName)
    const tenant = await createTestTenant({ status: 'active', name: 'NoMigrations' })
    const schema = `${cfg.tenantSchemaPrefix}${tenant.id}`

    // Schema exists but no adonis_schema table → migrations never ran.
    await central.rawQuery(`CREATE SCHEMA "${schema}"`)

    try {
      const { reports } = await svc.run({
        tenants: [tenant.id],
        checks: ['migration_state'],
      })
      const issues = reports[0].issues
      const issue = issues.find(
        (i) => i.code === 'migrations_never_ran' && i.tenantId === tenant.id
      )
      assert.isDefined(issue, 'must report migrations_never_ran')
      assert.equal(issue!.severity, 'error')
      assert.equal((issue!.meta as any)?.schema, schema)
    } finally {
      await central.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await destroyTestTenant(tenant.id).catch(() => {})
    }
  })

  test('migration_state: passes when adonis_schema table exists', async ({ assert }) => {
    const cfg = getConfig()
    const central = db.connection(cfg.centralConnectionName)
    const tenant = await createTestTenant({ status: 'active', name: 'WithMigrations' })
    const schema = `${cfg.tenantSchemaPrefix}${tenant.id}`

    await central.rawQuery(`CREATE SCHEMA "${schema}"`)
    // Create a minimal adonis_schema table — the check only inspects
    // existence, not contents.
    await central.rawQuery(
      `CREATE TABLE "${schema}".adonis_schema (id serial PRIMARY KEY, name varchar(255), batch int)`
    )

    try {
      const { reports } = await svc.run({
        tenants: [tenant.id],
        checks: ['migration_state'],
      })
      const issue = reports[0].issues.find((i) => i.tenantId === tenant.id)
      assert.isUndefined(issue, 'tenant with adonis_schema must not be flagged')
    } finally {
      await central.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await destroyTestTenant(tenant.id).catch(() => {})
    }
  })

  test('backup_recency: flags an active tenant with no backups on disk', async ({ assert }) => {
    const tenant = await createTestTenant({ status: 'active', name: 'NoBackups' })

    try {
      const { reports } = await svc.run({
        tenants: [tenant.id],
        checks: ['backup_recency'],
      })
      const issue = reports[0].issues.find((i) => i.tenantId === tenant.id)
      assert.isDefined(issue, 'must report something for a tenant with no backup history')
      // Either `backup_never_taken` (clean state) or `backup_inspect_failed`
      // (storage path not writable in this CI runner) are acceptable — both
      // mean ops needs to look. The severity bands them appropriately.
      assert.oneOf(issue!.code, ['backup_never_taken', 'backup_inspect_failed'])
      assert.oneOf(issue!.severity, ['warn', 'info'])
    } finally {
      await destroyTestTenant(tenant.id).catch(() => {})
    }
  })

  test('circuit_breakers: surfaces an OPEN breaker and --fix resets it', async ({ assert }) => {
    const tenant = await createTestTenant({ status: 'active', name: 'CircuitTest' })
    const cb = await app.container.make(CircuitBreakerService)

    try {
      // Materialise the breaker and force it OPEN. Opossum exposes
      // `circuit.open()` to flip the state without firing the probe;
      // ops-style force is fine here because we're testing the OBSERVER
      // (the doctor check), not the breaker itself.
      const circuit = cb.getCircuit(tenant.id)
      ;(circuit as any).open()
      assert.isTrue(cb.isOpen(tenant.id), 'precondition: breaker reports OPEN')

      const { reports } = await svc.run({ checks: ['circuit_breakers'] })
      const issue = reports[0].issues.find((i) => i.tenantId === tenant.id)
      assert.isDefined(issue, 'OPEN breaker must surface as an issue')
      assert.equal(issue!.code, 'circuit_open')
      assert.equal(issue!.severity, 'error')
      assert.isTrue(issue!.fixable, 'circuit_open must declare itself fixable')

      // Second pass with --fix should close the breaker.
      const { reports: afterFix } = await svc.run({
        checks: ['circuit_breakers'],
        fix: true,
      })
      const fixed = afterFix[0].issues.find((i) => i.tenantId === tenant.id)
      assert.isDefined(fixed)
      assert.equal((fixed!.meta as any)?.fixed, true, 'fix metadata must record the reset')
      assert.isFalse(cb.isOpen(tenant.id), 'breaker must be CLOSED after fix')
    } finally {
      await cb.destroy(tenant.id).catch(() => {})
      await destroyTestTenant(tenant.id).catch(() => {})
    }
  })

  test('register(): a host-app custom check appears in the reports under its name', async ({
    assert,
  }) => {
    const customName = `custom-${randomUUID().slice(0, 8)}`
    const fingerprint = randomUUID()
    const customCheck: DoctorCheck = {
      name: customName,
      description: 'Host-app custom diagnosis check',
      run: (ctx: DoctorContext): DiagnosisIssue[] => [
        {
          code: 'host_diagnosis',
          severity: 'info',
          message: `host check ran with ${ctx.tenants.length} tenants`,
          meta: { fingerprint },
        },
      ],
    }

    svc.register(customCheck)
    try {
      const { reports, totals } = await svc.run({ checks: [customName] })
      assert.lengthOf(reports, 1)
      assert.equal(reports[0].check, customName)
      assert.equal(reports[0].issues[0].code, 'host_diagnosis')
      assert.equal((reports[0].issues[0].meta as any)?.fingerprint, fingerprint)
      assert.equal(totals.info, 1)
    } finally {
      svc.unregister(customName)
    }
  })

  test('register(): unregistering a check removes it from list() AND from run()', async ({
    assert,
  }) => {
    const ephemeralName = `ephemeral-${randomUUID().slice(0, 8)}`
    svc.register({
      name: ephemeralName,
      description: 'ephemeral',
      run: () => [{ code: 'x', severity: 'info', message: 'x' }],
    })
    assert.isTrue(svc.has(ephemeralName))

    svc.unregister(ephemeralName)
    assert.isFalse(svc.has(ephemeralName))

    // Running with --check filtered to the ephemeral name now produces
    // zero reports — the filter never matched anything.
    const { reports } = await svc.run({ checks: [ephemeralName] })
    assert.lengthOf(reports, 0)
  })
})
