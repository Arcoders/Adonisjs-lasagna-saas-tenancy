import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'

/**
 * Metadata-only spec — see `create_tenant.spec.ts` for the rationale
 * behind not importing the command module here.
 */
test.group('tenant:restore — command metadata', () => {
  test('is registered in commands.json with the canonical contract', async ({ assert }) => {
    const json = JSON.parse(
      await readFile(new URL('../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:restore')
    assert.exists(entry, 'tenant:restore missing from commands.json')
    assert.equal(entry.filePath, 'tenant_restore.js')
    assert.match(entry.description, /restore.*backup/i)
    assert.equal(entry.options?.startApp, true)

    const flagNames = entry.flags.map((f: any) => f.flagName).sort()
    assert.deepEqual(flagNames, ['file', 'tenant'])
    assert.isTrue(
      entry.flags.every((f: any) => f.required),
      'both --tenant and --file must be required'
    )
  })

  test('barrel re-exports the command', async ({ assert }) => {
    const source = await readFile(
      new URL('../../src/commands/index.ts', import.meta.url),
      'utf-8'
    )
    assert.match(source, /TenantRestore.*from.*tenant_restore/)
  })
})
