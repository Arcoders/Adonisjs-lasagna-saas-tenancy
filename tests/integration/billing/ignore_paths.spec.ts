import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'

/**
 * `configure --with=billing` advertises `/webhooks/stripe` as an
 * `ignorePaths` entry, but the stub the configure step copies into the
 * host MUST already contain it. A host that follows the docs and pastes
 * the published config will hit `TenantGuard` on every webhook otherwise.
 *
 * This test reads the stub directly from disk — same bytes the user gets.
 */
test.group('multitenancy.stub default ignorePaths', () => {
  test("includes '/webhooks/stripe' in the default ignorePaths array", async ({ assert }) => {
    const stubUrl = new URL('../../../stubs/config/multitenancy.stub', import.meta.url)
    const text = await readFile(stubUrl, 'utf8')

    // We can't `eval` the stub (it contains AdonisJS-specific imports),
    // but we can extract the ignorePaths literal with a regex. The format
    // is stable: a JSON-style array assigned to the `ignorePaths` key.
    const match = /ignorePaths:\s*\[([^\]]+)\]/.exec(text)
    assert.isNotNull(match, 'ignorePaths key not found in stub')
    const list = match![1]
    assert.include(list, "'/webhooks/stripe'", 'webhook path missing from default ignorePaths')
  })

  test('includes the canonical paths a webhook flow needs', async ({ assert }) => {
    const stubUrl = new URL('../../../stubs/config/multitenancy.stub', import.meta.url)
    const text = await readFile(stubUrl, 'utf8')
    const match = /ignorePaths:\s*\[([^\]]+)\]/.exec(text)
    const list = match![1]
    // Defensive list of paths the package expects to be unauthenticated
    // out of the box — health, admin, generic webhooks, stripe webhook.
    for (const required of ["'/health'", "'/admin'", "'/webhooks/stripe'"]) {
      assert.include(list, required, `${required} missing from default ignorePaths`)
    }
  })
})
