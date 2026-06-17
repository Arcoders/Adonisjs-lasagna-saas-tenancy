import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'

/**
 * Metadata-only spec — see `create_tenant.spec.ts` for the rationale
 * behind not importing the command module here.
 */
test.group('tenant:doctor — command metadata', () => {
  test('is registered in commands.json with the full operator surface', async ({ assert }) => {
    const json = JSON.parse(
      await readFile(new URL('../../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:doctor')
    assert.exists(entry, 'tenant:doctor missing from commands.json')
    assert.equal(entry.filePath, 'tenant_doctor.js')
    assert.match(entry.description, /diagnose tenancy state/i)
    assert.equal(entry.options?.startApp, true)

    const flagNames = entry.flags.map((f: any) => f.flagName).sort()
    assert.deepEqual(flagNames, [
      'check',
      'fix',
      'interactive',
      'interval',
      'json',
      'tenant',
      'watch',
    ])
    assert.deepEqual(entry.args, [], 'tenant:doctor takes no positional args')
  })

  test('barrel re-exports the command', async ({ assert }) => {
    const source = await readFile(
      new URL('../../../src/commands/index.ts', import.meta.url),
      'utf-8'
    )
    assert.match(source, /TenantDoctor.*from.*tenant_doctor/)
  })
})
