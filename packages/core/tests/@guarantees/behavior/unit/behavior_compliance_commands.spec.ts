import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'

/**
 * Metadata-only spec. See `create_tenant.spec.ts` for why the command modules
 * are not imported here (they eagerly pull in a logger that top-level-awaits
 * `app.booted()`). We assert the ace manifest and the barrel re-export instead;
 * execution coverage lives in examples/api/tests/e2e.
 */
async function loadCommands() {
  const json = JSON.parse(
    await readFile(new URL('../../../../src/commands/commands.json', import.meta.url), 'utf-8')
  )
  return json.commands as any[]
}

test.group('compliance commands — metadata', () => {
  test('tenant:audit:export is registered with the full flag surface', async ({ assert }) => {
    const entry = (await loadCommands()).find((c) => c.commandName === 'tenant:audit:export')
    assert.exists(entry, 'tenant:audit:export missing from commands.json')
    assert.equal(entry.filePath, 'tenant_audit_export.js')
    assert.equal(entry.options?.startApp, true)
    assert.deepEqual(entry.flags.map((f: any) => f.flagName).sort(), [
      'format',
      'from',
      'out',
      'tenant',
      'to',
    ])
    assert.deepEqual(entry.args, [], 'audit:export takes no positional args')
  })

  test('tenant:gdpr:anonymize is registered and takes a required tenantId', async ({ assert }) => {
    const entry = (await loadCommands()).find((c) => c.commandName === 'tenant:gdpr:anonymize')
    assert.exists(entry, 'tenant:gdpr:anonymize missing from commands.json')
    assert.equal(entry.filePath, 'tenant_gdpr_anonymize.js')
    assert.equal(entry.options?.startApp, true)
    assert.deepEqual(entry.flags.map((f: any) => f.flagName).sort(), ['dry-run', 'force', 'reason'])
    assert.equal(entry.args[0]?.argumentName, 'tenantId')
    assert.isTrue(entry.args[0]?.required)
  })

  test('tenant:compliance:report is registered with framework/control/json/strict', async ({
    assert,
  }) => {
    const entry = (await loadCommands()).find((c) => c.commandName === 'tenant:compliance:report')
    assert.exists(entry, 'tenant:compliance:report missing from commands.json')
    assert.equal(entry.filePath, 'tenant_compliance_report.js')
    assert.equal(entry.options?.startApp, true)
    assert.deepEqual(entry.flags.map((f: any) => f.flagName).sort(), [
      'control',
      'framework',
      'json',
      'strict',
    ])
  })

  test('barrel re-exports the three commands', async ({ assert }) => {
    const source = await readFile(
      new URL('../../../../src/commands/index.ts', import.meta.url),
      'utf-8'
    )
    assert.match(source, /TenantAuditExport.*from.*tenant_audit_export/)
    assert.match(source, /TenantGdprAnonymize.*from.*tenant_gdpr_anonymize/)
    assert.match(source, /TenantComplianceReport.*from.*tenant_compliance_report/)
  })
})
