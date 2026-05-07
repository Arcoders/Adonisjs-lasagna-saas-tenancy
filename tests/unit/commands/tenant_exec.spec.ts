import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import TenantExec from '../../../src/commands/tenant_exec.js'

test.group('tenant:exec — command metadata', () => {
  test('exports a command with the canonical name', ({ assert }) => {
    assert.equal(TenantExec.commandName, 'tenant:exec')
  })

  test('description names the contract clearly', ({ assert }) => {
    assert.match(TenantExec.description, /any ace command/i)
  })

  test('starts the app (needs the container booted)', ({ assert }) => {
    assert.equal(TenantExec.options?.startApp, true)
  })

  test('is registered in commands.json with the expected flags and args', async ({
    assert,
  }) => {
    const json = JSON.parse(
      await readFile(new URL('../../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:exec')
    assert.exists(entry, 'tenant:exec missing from commands.json')
    assert.equal(entry.filePath, 'tenant_exec.js')

    const flagNames = entry.flags.map((f: any) => f.flagName).sort()
    assert.deepEqual(flagNames, [
      'batch-size',
      'continue-on-error',
      'dry-run',
      'include-deleted',
      'limit',
      'status',
      'tenant',
    ])

    const argNames = entry.args.map((a: any) => a.argumentName)
    assert.deepEqual(argNames, ['command', 'commandArgs'])
    const spreadArg = entry.args.find((a: any) => a.argumentName === 'commandArgs')
    assert.equal(spreadArg.type, 'spread')
  })

  test('barrel re-exports the command (text check, no eager import)', async ({
    assert,
  }) => {
    const source = await readFile(
      new URL('../../../src/commands/index.ts', import.meta.url),
      'utf-8'
    )
    assert.match(source, /TenantExec.*from.*tenant_exec/)
  })
})
