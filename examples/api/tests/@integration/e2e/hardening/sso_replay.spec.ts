import { test } from '@japa/runner'
import redis from '@adonisjs/redis/services/main'
import { randomUUID } from 'node:crypto'

/**
 * HARDENING — SSO state replay protection.
 *
 * The SSO satellite consumes the OIDC `state` with an atomic Redis GETDEL
 * (packages/sso/src/sso_service.ts): the first caller to observe the value wins
 * and proceeds; a concurrent second caller observes `null` and is rejected with
 * "invalid or expired sso state". That single atomic op is what closes the
 * TOCTOU window two simultaneous callbacks would otherwise open.
 *
 * The authoritative full-flow proof (two concurrent `handleCallback`s against a
 * mock IdP, exactly one fulfilled) is
 * packages/core/tests/integration/services/sso_oidc_flow.spec.ts:313. The demo
 * app does not expose OIDC callbacks over HTTP, so here we prove the underlying
 * primitive directly against the app's live Redis — deterministically, with no
 * mock-IdP dependency, so it can never flake.
 */
test.group('hardening — SSO state replay protection (atomic GETDEL)', () => {
  test('two concurrent consumers of one state — exactly one wins', async ({ assert }) => {
    const stateKey = `sso:state:e2e:${randomUUID()}`
    const stateValue = JSON.stringify({ tenantId: randomUUID(), nonce: randomUUID() })
    await redis.set(stateKey, stateValue, 'EX', 60)

    // Race two GETDELs on the same key — the exact contention two simultaneous
    // OIDC callbacks would create.
    const [first, second] = await Promise.all([redis.getdel(stateKey), redis.getdel(stateKey)])

    const winners = [first, second].filter((v) => v !== null)
    const losers = [first, second].filter((v) => v === null)

    assert.lengthOf(winners, 1, 'exactly one consumer may observe the state value')
    assert.lengthOf(losers, 1, 'the replayed consumer must observe null (state already consumed)')
    assert.equal(winners[0], stateValue, 'the winning consumer reads the original state payload')

    // The key is gone — a third replay attempt also gets nothing.
    assert.isNull(await redis.get(stateKey), 'state must be deleted after first consumption')
  })
})
