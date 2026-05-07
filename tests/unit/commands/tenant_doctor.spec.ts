import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import TenantDoctor from '../../../src/commands/tenant_doctor.js'

test.group('tenant:doctor — command metadata', () => {
  test('exports a command with the canonical name', ({ assert }) => {
    assert.equal(TenantDoctor.commandName, 'tenant:doctor')
  })

  test('description names the contract clearly', ({ assert }) => {
    assert.match(TenantDoctor.description, /diagnose tenancy state/i)
  })

  test('starts the app (DoctorService and checks need the container booted)', ({ assert }) => {
    assert.equal(TenantDoctor.options?.startApp, true)
  })

  test('is registered in commands.json with the full operator surface', async ({ assert }) => {
    const json = JSON.parse(
      await readFile(new URL('../../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:doctor')
    assert.exists(entry, 'tenant:doctor missing from commands.json')
    assert.equal(entry.filePath, 'tenant_doctor.js')

    const flagNames = entry.flags.map((f: any) => f.flagName).sort()
    assert.deepEqual(flagNames, ['check', 'fix', 'interval', 'json', 'tenant', 'watch'])
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
