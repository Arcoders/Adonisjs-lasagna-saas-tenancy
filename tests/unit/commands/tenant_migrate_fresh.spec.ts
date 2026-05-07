import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import TenantMigrateFresh from '../../../src/commands/tenant_migrate_fresh.js'

test.group('tenant:migrate:fresh — command metadata', () => {
  test('exports a command with the canonical name', ({ assert }) => {
    assert.equal(TenantMigrateFresh.commandName, 'tenant:migrate:fresh')
  })

  test('description warns about destructiveness', ({ assert }) => {
    assert.match(TenantMigrateFresh.description, /destructive/i)
  })

  test('starts the app (needs the container booted)', ({ assert }) => {
    assert.equal(TenantMigrateFresh.options?.startApp, true)
  })

  test('is registered in commands.json with matching flags', async ({ assert }) => {
    const json = JSON.parse(
      await readFile(new URL('../../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find(
      (c: any) => c.commandName === 'tenant:migrate:fresh'
    )
    assert.exists(entry, 'tenant:migrate:fresh missing from commands.json')
    assert.equal(entry.filePath, 'tenant_migrate_fresh.js')
    const flagNames = entry.flags.map((f: any) => f.flagName).sort()
    assert.deepEqual(flagNames, ['disable-locks', 'force', 'seed', 'tenant', 'verbose'])
  })

  test('barrel re-exports the command name (text check, no eager import)', async ({
    assert,
  }) => {
    // We verify the export by reading the source so the test stays hermetic
    // — importing the barrel would eager-load every command, which drags
    // the Adonis app boot path into a unit test process.
    const source = await readFile(
      new URL('../../../src/commands/index.ts', import.meta.url),
      'utf-8'
    )
    assert.match(source, /TenantMigrateFresh.*from.*tenant_migrate_fresh/)
  })
})
