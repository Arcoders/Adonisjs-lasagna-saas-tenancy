import { test } from '@japa/runner'
import auditImmutabilityControl from '../../../../src/services/compliance/controls/audit_immutability_control.js'
import secretEncryptionControl from '../../../../src/services/compliance/controls/secret_encryption_control.js'
import tenantIsolationControl from '../../../../src/services/compliance/controls/tenant_isolation_control.js'
import accessAuthorizationControl from '../../../../src/services/compliance/controls/access_authorization_control.js'
import dataRetentionControl from '../../../../src/services/compliance/controls/data_retention_control.js'
import type { ComplianceContext } from '../../../../src/services/compliance/types.js'
import type { MultitenancyConfig } from '../../../../src/types/config.js'
import { testConfig } from '../../../helpers/config.js'

const ALL_TRIGGERS = [
  { tgname: 'tenant_audit_logs_no_update' },
  { tgname: 'tenant_audit_logs_no_delete' },
  { tgname: 'tenant_audit_logs_no_truncate' },
]

function ctx(
  configOverrides: Partial<MultitenancyConfig> = {},
  triggerRows: Array<{ tgname: string }> = [],
  onConnect?: (name: string) => void
): ComplianceContext {
  return {
    config: { ...testConfig, ...configOverrides } as MultitenancyConfig,
    db: {
      connection: (name: string) => {
        onConnect?.(name)
        return { rawQuery: async () => ({ rows: triggerRows }) }
      },
    } as any,
  }
}

test.group('control — audit-immutability', () => {
  test('satisfied when all three triggers are present', async ({ assert }) => {
    const r = await auditImmutabilityControl.detect(ctx({}, ALL_TRIGGERS))
    assert.equal(r.status, 'satisfied')
    assert.notExists(r.remediation)
  })

  test('action-needed (with remediation) when a trigger is missing', async ({ assert }) => {
    const r = await auditImmutabilityControl.detect(ctx({}, ALL_TRIGGERS.slice(0, 2)))
    assert.equal(r.status, 'action-needed')
    assert.match(r.evidence, /tenant_audit_logs_no_truncate/)
    assert.match(r.remediation ?? '', /--with=audit/)
  })

  test('action-needed when the audit table is absent (zero rows, no throw)', async ({ assert }) => {
    const r = await auditImmutabilityControl.detect(ctx({}, []))
    assert.equal(r.status, 'action-needed')
  })

  test('queries on the backoffice connection', async ({ assert }) => {
    let used = ''
    await auditImmutabilityControl.detect(
      ctx({ backofficeConnectionName: 'backoffice' }, ALL_TRIGGERS, (n) => (used = n))
    )
    assert.equal(used, 'backoffice')
  })

  test('binds the configured backoffice schema name instead of a hardcoded literal', async ({
    assert,
  }) => {
    let sql = ''
    let bindings: unknown[] = []
    const context = {
      config: { ...testConfig, backofficeSchemaName: 'tenants_admin' } as MultitenancyConfig,
      db: {
        connection: () => ({
          rawQuery: async (q: string, b: unknown[]) => {
            sql = q
            bindings = b
            return { rows: ALL_TRIGGERS }
          },
        }),
      } as any,
    } as ComplianceContext

    const r = await auditImmutabilityControl.detect(context)

    assert.equal(r.status, 'satisfied')
    assert.notInclude(sql, "'backoffice'", 'the schema must not be a hardcoded SQL literal')
    assert.match(sql, /nspname = \?/)
    assert.include(bindings as string[], 'tenants_admin')
    // Evidence reflects the configured schema, so the report reads correctly
    // for a host that renamed the backoffice schema.
    assert.match(r.evidence, /tenants_admin\.tenant_audit_logs/)
  })
})

test.group('control — secret-encryption', (group) => {
  let saved: string | undefined
  group.each.setup(() => {
    saved = process.env.APP_KEY
    return () => {
      if (saved === undefined) delete process.env.APP_KEY
      else process.env.APP_KEY = saved
    }
  })

  test('satisfied when APP_KEY is set; evidence scopes it to secrets', async ({ assert }) => {
    process.env.APP_KEY = 'x'.repeat(32)
    const r = await secretEncryptionControl.detect(ctx())
    assert.equal(r.status, 'satisfied')
    assert.match(r.evidence, /SECRETS only/)
  })

  test('action-needed when APP_KEY is unset', async ({ assert }) => {
    delete process.env.APP_KEY
    const r = await secretEncryptionControl.detect(ctx())
    assert.equal(r.status, 'action-needed')
  })
})

test.group('control — tenant-isolation', () => {
  test('defaults to schema-pg when no isolation block is set', async ({ assert }) => {
    const r = await tenantIsolationControl.detect(ctx())
    assert.equal(r.status, 'satisfied')
    assert.match(r.evidence, /schema-pg/)
  })

  test('database-pg reports OS-level separation', async ({ assert }) => {
    const r = await tenantIsolationControl.detect(
      ctx({ isolation: { driver: 'database-pg' } as any })
    )
    assert.equal(r.status, 'satisfied')
    assert.match(r.evidence, /OS\/process-level/)
  })

  test('rowscope-pg warns about cross-tenant query auditing', async ({ assert }) => {
    const r = await tenantIsolationControl.detect(
      ctx({ isolation: { driver: 'rowscope-pg' } as any })
    )
    assert.equal(r.status, 'satisfied')
    assert.match(r.hostResponsibility, /rowscope-pg/)
  })

  test('sqlite-memory is action-needed (test fixture, not a posture)', async ({ assert }) => {
    const r = await tenantIsolationControl.detect(
      ctx({ isolation: { driver: 'sqlite-memory' } as any })
    )
    assert.equal(r.status, 'action-needed')
  })
})

test.group('control — access-authorization', () => {
  test('satisfied when authorizeTenantAccess is wired', async ({ assert }) => {
    const r = await accessAuthorizationControl.detect(ctx({ authorizeTenantAccess: () => true }))
    assert.equal(r.status, 'satisfied')
  })

  test('action-needed when the hook is unset', async ({ assert }) => {
    const r = await accessAuthorizationControl.detect(ctx())
    assert.equal(r.status, 'action-needed')
    assert.match(r.evidence, /IDOR/)
  })
})

test.group('control — data-retention', () => {
  test('satisfied when retentionDays is configured', async ({ assert }) => {
    const r = await dataRetentionControl.detect(ctx({ softDelete: { retentionDays: 90 } }))
    assert.equal(r.status, 'satisfied')
    assert.match(r.evidence, /90/)
  })

  test('info (with the default) when retentionDays is unset', async ({ assert }) => {
    const r = await dataRetentionControl.detect(ctx())
    assert.equal(r.status, 'info')
    assert.match(r.evidence, /30 days/)
  })
})
