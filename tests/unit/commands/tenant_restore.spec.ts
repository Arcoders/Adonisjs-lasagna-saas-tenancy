import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import TenantRestore from '../../../src/commands/tenant_restore.js'

test.group('tenant:restore — command metadata', () => {
  test('exports a command with the canonical name', ({ assert }) => {
    assert.equal(TenantRestore.commandName, 'tenant:restore')
  })

  test('description names the contract clearly', ({ assert }) => {
    assert.match(TenantRestore.description, /restore.*backup/i)
  })

  test('starts the app (BackupService reads runtime config)', ({ assert }) => {
    assert.equal(TenantRestore.options?.startApp, true)
  })

  test('is registered in commands.json with --tenant + --file required flags', async ({
    assert,
  }) => {
    const json = JSON.parse(
      await readFile(new URL('../../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:restore')
    assert.exists(entry, 'tenant:restore missing from commands.json')
    assert.equal(entry.filePath, 'tenant_restore.js')

    const flagNames = entry.flags.map((f: any) => f.flagName).sort()
    assert.deepEqual(flagNames, ['file', 'tenant'])
    assert.isTrue(
      entry.flags.every((f: any) => f.required),
      'both --tenant and --file must be required'
    )
  })

  test('barrel re-exports the command', async ({ assert }) => {
    const source = await readFile(
      new URL('../../../src/commands/index.ts', import.meta.url),
      'utf-8'
    )
    assert.match(source, /TenantRestore.*from.*tenant_restore/)
  })
})
