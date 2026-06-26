import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'

/**
 * Metadata-only spec — see `create_tenant.spec.ts` for the rationale
 * behind not importing the command module here. We assert the same
 * contract through `commands.json` + the barrel.
 */
test.group('tenant:destroy — command metadata', () => {
  test('is registered in commands.json with the canonical contract', async ({ assert }) => {
    const json = JSON.parse(
      await readFile(new URL('../../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:destroy')
    assert.exists(entry, 'tenant:destroy missing from commands.json')
    assert.equal(entry.filePath, 'destroy_tenant.js')
    assert.match(entry.description, /soft-delete.*tear down/i)
    assert.equal(entry.options?.startApp, true)

    const flagNames = entry.flags.map((f: any) => f.flagName).sort()
    assert.deepEqual(flagNames, ['admin', 'force', 'keep-schema'])

    const argNames = entry.args.map((a: any) => a.argumentName)
    assert.deepEqual(argNames, ['tenantId'])
  })

  test('barrel re-exports the command', async ({ assert }) => {
    const source = await readFile(
      new URL('../../../src/commands/index.ts', import.meta.url),
      'utf-8'
    )
    assert.match(source, /DestroyTenant.*from.*destroy_tenant/)
  })
})
