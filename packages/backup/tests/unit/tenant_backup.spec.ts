import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'

/**
 * Metadata-only spec — see `create_tenant.spec.ts` for the rationale
 * behind not importing the command module here.
 */
test.group('tenant:backup — command metadata', () => {
  test('is registered in commands.json with the canonical contract', async ({ assert }) => {
    const json = JSON.parse(
      await readFile(new URL('../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:backup')
    assert.exists(entry, 'tenant:backup missing from commands.json')
    assert.equal(entry.filePath, 'tenant_backup.js')
    assert.match(entry.description, /backup.*tenant/i)
    assert.equal(entry.options?.startApp, true)

    const flagNames = entry.flags.map((f: any) => f.flagName).sort()
    assert.deepEqual(flagNames, ['tenant'])
    const tenantFlag = entry.flags.find((f: any) => f.flagName === 'tenant')
    assert.equal(tenantFlag.type, 'array')
  })

  test('barrel re-exports the command', async ({ assert }) => {
    const source = await readFile(new URL('../../src/commands/index.ts', import.meta.url), 'utf-8')
    assert.match(source, /TenantBackup.*from.*tenant_backup/)
  })
})
