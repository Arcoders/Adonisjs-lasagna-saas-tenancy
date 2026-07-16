import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'

/**
 * HARDENING: audit log immutability.
 *
 * The package's audit log (`backoffice.tenant_audit_logs`) is append-only. The
 * guarantee is enforced in PostgreSQL itself: BEFORE UPDATE / BEFORE DELETE row
 * triggers and a BEFORE TRUNCATE statement trigger all call
 * `backoffice.tenant_audit_logs_no_mutate()`, which raises with ERRCODE
 * `insufficient_privilege`. INSERT (the only legitimate operation) stays
 * allowed. This means a compromised tenant role, or a buggy controller, cannot
 * rewrite or erase the evidence trail.
 *
 * The canonical migration stub ships these triggers
 * (packages/core/stubs/migrations/create_tenant_audit_logs_table.stub) and the
 * demo's own migration now mirrors them. To stay fire-proof on a database that
 * was migrated before that change, the suite re-asserts the triggers
 * idempotently in setup, the same runtime-provisioning pattern the package's
 * own integration bootstrap uses. CREATE OR REPLACE / DROP IF EXISTS make this
 * a no-op when they already exist.
 *
 * NOTE: probe rows are intentionally NOT deleted afterwards. DELETE is exactly
 * what the table forbids, and an unbounded append-only log is the design. Each
 * run tags its rows with a unique tenant id so they never collide.
 */
test.group('hardening — audit log immutability', (group) => {
  const conn = () => db.connection('public')
  const probeTenant = randomUUID()
  let rowId = ''

  group.setup(async () => {
    await conn().rawQuery(`
      CREATE OR REPLACE FUNCTION backoffice.tenant_audit_logs_no_mutate()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'tenant_audit_logs is append-only; UPDATE/DELETE is forbidden'
          USING ERRCODE = 'insufficient_privilege';
      END;
      $$ LANGUAGE plpgsql;
    `)
    await conn().rawQuery(`
      DROP TRIGGER IF EXISTS tenant_audit_logs_no_update ON backoffice.tenant_audit_logs;
      CREATE TRIGGER tenant_audit_logs_no_update
      BEFORE UPDATE ON backoffice.tenant_audit_logs
      FOR EACH ROW EXECUTE FUNCTION backoffice.tenant_audit_logs_no_mutate();
    `)
    await conn().rawQuery(`
      DROP TRIGGER IF EXISTS tenant_audit_logs_no_delete ON backoffice.tenant_audit_logs;
      CREATE TRIGGER tenant_audit_logs_no_delete
      BEFORE DELETE ON backoffice.tenant_audit_logs
      FOR EACH ROW EXECUTE FUNCTION backoffice.tenant_audit_logs_no_mutate();
    `)
    await conn().rawQuery(`
      DROP TRIGGER IF EXISTS tenant_audit_logs_no_truncate ON backoffice.tenant_audit_logs;
      CREATE TRIGGER tenant_audit_logs_no_truncate
      BEFORE TRUNCATE ON backoffice.tenant_audit_logs
      FOR EACH STATEMENT EXECUTE FUNCTION backoffice.tenant_audit_logs_no_mutate();
    `)
  })

  test('INSERT is allowed — the log is append-only, not read-only', async ({ assert }) => {
    const res = await conn().rawQuery(
      `INSERT INTO backoffice.tenant_audit_logs (tenant_id, actor_type, action)
       VALUES (?, 'system', ?) RETURNING id`,
      [probeTenant, 'e2e.audit.immutability.probe']
    )
    rowId = res.rows[0].id
    assert.isString(rowId, 'INSERT must succeed and return the new row id')
  })

  test('UPDATE is blocked by the trigger and leaves the row untouched', async ({ assert }) => {
    await assert.rejects(
      () =>
        conn().rawQuery(
          `UPDATE backoffice.tenant_audit_logs SET action = 'tampered' WHERE id = ?`,
          [rowId]
        ),
      /append-only|insufficient_privilege/i
    )

    const after = await conn().rawQuery(
      `SELECT action FROM backoffice.tenant_audit_logs WHERE id = ?`,
      [rowId]
    )
    assert.equal(
      after.rows[0].action,
      'e2e.audit.immutability.probe',
      'the action column must be unchanged after a blocked UPDATE'
    )
  })

  test('DELETE is blocked by the trigger and the row survives', async ({ assert }) => {
    await assert.rejects(
      () => conn().rawQuery(`DELETE FROM backoffice.tenant_audit_logs WHERE id = ?`, [rowId]),
      /append-only|insufficient_privilege/i
    )

    const after = await conn().rawQuery(`SELECT 1 FROM backoffice.tenant_audit_logs WHERE id = ?`, [
      rowId,
    ])
    assert.lengthOf(after.rows, 1, 'the row must still exist after a blocked DELETE')
  })

  test('TRUNCATE is blocked by the statement-level trigger', async ({ assert }) => {
    const before = await conn().rawQuery(
      `SELECT count(*)::int AS n FROM backoffice.tenant_audit_logs`
    )
    const countBefore = before.rows[0].n as number

    await assert.rejects(
      () => conn().rawQuery(`TRUNCATE TABLE backoffice.tenant_audit_logs`),
      /append-only|insufficient_privilege/i
    )

    const after = await conn().rawQuery(
      `SELECT count(*)::int AS n FROM backoffice.tenant_audit_logs`
    )
    assert.equal(
      after.rows[0].n,
      countBefore,
      'TRUNCATE must not have removed any rows (it was rejected before executing)'
    )
    assert.isAtLeast(after.rows[0].n, 1, 'the probe row inserted earlier must still be present')
  })
})
