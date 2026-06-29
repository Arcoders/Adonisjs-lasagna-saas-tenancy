import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'

/**
 * Metadata-only spec. We intentionally do NOT import
 * `src/commands/create_tenant.ts`: its module graph reaches
 * `jobs/install_tenant.ts`, which eagerly imports
 * `@adonisjs/core/services/logger`. That logger module top-level
 * `await`s `app.booted(...)`, which throws when evaluated outside an
 * Ignitor (i.e. the unit suite). Reading the same contract from
 * `commands.json` + the barrel keeps the assertion meaningful while
 * staying side-effect-free.
 */
test.group('tenant:create — command metadata', () => {
  test('is registered in commands.json with the canonical contract', async ({ assert }) => {
    const json = JSON.parse(
      await readFile(new URL('../../../../src/commands/commands.json', import.meta.url), 'utf-8')
    )
    const entry = json.commands.find((c: any) => c.commandName === 'tenant:create')
    assert.exists(entry, 'tenant:create missing from commands.json')
    assert.equal(entry.filePath, 'create_tenant.js')
    assert.match(entry.description, /create a new tenant/i)
    assert.equal(entry.options?.startApp, true, 'must start the app to resolve the repo')

    const argNames = entry.args.map((a: any) => a.argumentName)
    assert.deepEqual(argNames, ['name', 'email'])
    assert.isTrue(
      entry.args.every((a: any) => a.required),
      'both args must be required'
    )
  })

  test('barrel re-exports the command (text check, no eager import)', async ({ assert }) => {
    const source = await readFile(
      new URL('../../../../src/commands/index.ts', import.meta.url),
      'utf-8'
    )
    assert.match(source, /CreateTenant.*from.*create_tenant/)
  })
})
