import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'

/**
 * Metadata-only spec — see `create_tenant.spec.ts` for the rationale behind not
 * importing the command module here. Execution coverage lives in the e2e suite.
 */
test.group('tenant:satellite:remove — command metadata', () => {
  test('is registered in commands.json with a single package arg and startApp:false', async ({
    assert,
  }) => {
    const json = JSON.parse(
      await readFile(new URL('../../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:satellite:remove')
    assert.exists(entry, 'tenant:satellite:remove missing from commands.json')
    assert.equal(entry.filePath, 'tenant_satellite_remove.js')
    assert.equal(entry.options?.startApp, false, 'read-only: must not boot the app')
    assert.deepEqual(
      entry.args.map((a: any) => a.argumentName),
      ['package']
    )
    assert.isTrue(entry.args[0].required)
    assert.deepEqual(entry.flags, [])
  })

  test('barrel re-exports the command', async ({ assert }) => {
    const source = await readFile(
      new URL('../../../src/commands/index.ts', import.meta.url),
      'utf-8'
    )
    assert.match(source, /TenantSatelliteRemove.*from.*tenant_satellite_remove/)
  })
})
