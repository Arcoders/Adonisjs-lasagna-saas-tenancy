import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import CreateTenant from '../../../src/commands/create_tenant.js'

test.group('tenant:create — command metadata', () => {
  test('exports a command with the canonical name', ({ assert }) => {
    assert.equal(CreateTenant.commandName, 'tenant:create')
  })

  test('description names the contract clearly', ({ assert }) => {
    assert.match(CreateTenant.description, /create a new tenant/i)
  })

  test('starts the app (needs the container booted to resolve the repo)', ({ assert }) => {
    assert.equal(CreateTenant.options?.startApp, true)
  })

  test('is registered in commands.json with name + email args', async ({ assert }) => {
    const json = JSON.parse(
      await readFile(new URL('../../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:create')
    assert.exists(entry, 'tenant:create missing from commands.json')
    assert.equal(entry.filePath, 'create_tenant.js')

    const argNames = entry.args.map((a: any) => a.argumentName)
    assert.deepEqual(argNames, ['name', 'email'])
    assert.isTrue(entry.args.every((a: any) => a.required), 'both args must be required')
  })

  test('barrel re-exports the command (text check, no eager import)', async ({ assert }) => {
    const source = await readFile(
      new URL('../../../src/commands/index.ts', import.meta.url),
      'utf-8'
    )
    assert.match(source, /CreateTenant.*from.*create_tenant/)
  })
})
