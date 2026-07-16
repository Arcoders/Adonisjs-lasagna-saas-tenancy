import { test } from '@japa/runner'
import { runAce } from './_helpers.js'

/**
 * quickstart.md / commands.md: `backoffice:setup` is "Idempotent; re-run any
 * time". The e2e bootstrap already ran it once against this database, so a
 * second (and third) run here proves the in-version re-run contract: exit 0,
 * no duplicate-migration failures, no schema errors.
 */
test.group('backoffice:setup — re-run idempotency (e2e)', () => {
  test('a second run on an already-provisioned backoffice exits 0', async ({ assert }) => {
    assert.equal(await runAce('backoffice:setup'), 0)
  })

  test('a third run is still a no-op success', async ({ assert }) => {
    assert.equal(await runAce('backoffice:setup'), 0)
  })
})
