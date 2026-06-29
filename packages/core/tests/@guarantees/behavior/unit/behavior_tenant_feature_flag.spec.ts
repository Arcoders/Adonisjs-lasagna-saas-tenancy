import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'

/**
 * Metadata-only spec — see `create_tenant.spec.ts` for why the command modules
 * are not imported here. We verify the four `tenant:feature-flag:*` commands
 * are registered in `commands.json` with the right contract and re-exported
 * from the barrel.
 */
async function commands() {
  const json = JSON.parse(
    await readFile(new URL('../../../../src/commands/commands.json', import.meta.url), 'utf-8')
  )
  return json.commands as any[]
}

async function barrel() {
  return readFile(new URL('../../../../src/commands/index.ts', import.meta.url), 'utf-8')
}

test.group('tenant:feature-flag:* — command metadata', () => {
  test('set is registered with tenantId/flag/enabled args and config/expires-at flags', async ({
    assert,
  }) => {
    const entry = (await commands()).find((c) => c.commandName === 'tenant:feature-flag:set')
    assert.exists(entry, 'tenant:feature-flag:set missing from commands.json')
    assert.equal(entry.filePath, 'tenant_feature_flag_set.js')
    assert.equal(entry.options?.startApp, true)

    assert.deepEqual(
      entry.args.map((a: any) => a.argumentName),
      ['tenantId', 'flag', 'enabled']
    )
    assert.isTrue(
      entry.args.every((a: any) => a.required),
      'all three args are required'
    )
    assert.deepEqual(entry.flags.map((f: any) => f.flagName).sort(), ['config', 'expires-at'])
  })

  test('get is registered with tenantId/flag args and no flags', async ({ assert }) => {
    const entry = (await commands()).find((c) => c.commandName === 'tenant:feature-flag:get')
    assert.exists(entry)
    assert.equal(entry.filePath, 'tenant_feature_flag_get.js')
    assert.equal(entry.options?.startApp, true)
    assert.deepEqual(
      entry.args.map((a: any) => a.argumentName),
      ['tenantId', 'flag']
    )
    assert.deepEqual(entry.flags, [])
  })

  test('list is registered with a tenantId arg and a --json flag', async ({ assert }) => {
    const entry = (await commands()).find((c) => c.commandName === 'tenant:feature-flag:list')
    assert.exists(entry)
    assert.equal(entry.filePath, 'tenant_feature_flag_list.js')
    assert.equal(entry.options?.startApp, true)
    assert.deepEqual(
      entry.args.map((a: any) => a.argumentName),
      ['tenantId']
    )
    assert.deepEqual(
      entry.flags.map((f: any) => f.flagName),
      ['json']
    )
  })

  test('delete is registered with tenantId/flag args and a --force flag', async ({ assert }) => {
    const entry = (await commands()).find((c) => c.commandName === 'tenant:feature-flag:delete')
    assert.exists(entry)
    assert.equal(entry.filePath, 'tenant_feature_flag_delete.js')
    assert.equal(entry.options?.startApp, true)
    assert.deepEqual(
      entry.args.map((a: any) => a.argumentName),
      ['tenantId', 'flag']
    )
    assert.deepEqual(
      entry.flags.map((f: any) => f.flagName),
      ['force']
    )
  })

  test('barrel re-exports all four commands', async ({ assert }) => {
    const source = await barrel()
    assert.match(source, /TenantFeatureFlagSet.*from.*tenant_feature_flag_set/)
    assert.match(source, /TenantFeatureFlagGet.*from.*tenant_feature_flag_get/)
    assert.match(source, /TenantFeatureFlagList.*from.*tenant_feature_flag_list/)
    assert.match(source, /TenantFeatureFlagDelete.*from.*tenant_feature_flag_delete/)
  })
})
