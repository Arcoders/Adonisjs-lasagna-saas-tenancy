import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import TenantBackup from '../../../src/commands/tenant_backup.js'

test.group('tenant:backup — command metadata', () => {
  test('exports a command with the canonical name', ({ assert }) => {
    assert.equal(TenantBackup.commandName, 'tenant:backup')
  })

  test('description names the contract clearly', ({ assert }) => {
    assert.match(TenantBackup.description, /backup.*tenant/i)
  })

  test('starts the app (BackupService reads runtime config)', ({ assert }) => {
    assert.equal(TenantBackup.options?.startApp, true)
  })

  test('is registered in commands.json with the --tenant filter flag', async ({ assert }) => {
    const json = JSON.parse(
      await readFile(new URL('../../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:backup')
    assert.exists(entry, 'tenant:backup missing from commands.json')
    assert.equal(entry.filePath, 'tenant_backup.js')

    const flagNames = entry.flags.map((f: any) => f.flagName).sort()
    assert.deepEqual(flagNames, ['tenant'])
    const tenantFlag = entry.flags.find((f: any) => f.flagName === 'tenant')
    assert.equal(tenantFlag.type, 'array')
  })

  test('barrel re-exports the command', async ({ assert }) => {
    const source = await readFile(
      new URL('../../../src/commands/index.ts', import.meta.url),
      'utf-8'
    )
    assert.match(source, /TenantBackup.*from.*tenant_backup/)
  })
})
