import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import DestroyTenant from '../../../src/commands/destroy_tenant.js'

test.group('tenant:destroy — command metadata', () => {
  test('exports a command with the canonical name', ({ assert }) => {
    assert.equal(DestroyTenant.commandName, 'tenant:destroy')
  })

  test('description names the contract clearly', ({ assert }) => {
    assert.match(DestroyTenant.description, /soft-delete.*tear down/i)
  })

  test('starts the app (lifecycle hooks + driver need the container)', ({ assert }) => {
    assert.equal(DestroyTenant.options?.startApp, true)
  })

  test('is registered in commands.json with --force and --keep-schema flags', async ({
    assert,
  }) => {
    const json = JSON.parse(
      await readFile(new URL('../../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:destroy')
    assert.exists(entry, 'tenant:destroy missing from commands.json')
    assert.equal(entry.filePath, 'destroy_tenant.js')

    const flagNames = entry.flags.map((f: any) => f.flagName).sort()
    assert.deepEqual(flagNames, ['force', 'keep-schema'])

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
