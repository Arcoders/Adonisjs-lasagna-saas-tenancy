import { test } from '@japa/runner'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { buildToolChat, fakeTenant, toolChatBody } from '../../../helpers/tool_chat_doubles.js'
import { MAX_AI_TOOL_ROUNDS } from '../../../../src/constants.js'

/**
 * The denial-of-wallet rail for a tool loop: a loop re-enters the provider up to
 * `maxRounds` times, so the SINGLE reservation the controller takes must cover
 * the aggregate worst case (`perRound × maxRounds`), not one round. Under-reserving
 * would let a loop generate up to maxRounds× its reserved tokens before the
 * pipeline's cumulative budget check could stop it. The clamp is shared with the
 * loop's own round ceiling (`resolveMaxRounds`), so the reservation and the loop
 * can never drift apart.
 */

test.group('security — the tool-loop reservation covers the aggregate budget', () => {
  test('a tool request reserves perRound x maxRounds, not one round', async ({ assert }) => {
    const { controller, quota } = buildToolChat({ tools: { maxRounds: 3 } })
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    assert.deepEqual(quota.reserves, [1024 * 3], 'one aggregate reservation for the whole loop')
  })

  test('each round is still capped at the per-round token ceiling', async ({ assert }) => {
    const { controller, provider } = buildToolChat({ tools: { maxRounds: 3 } })
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    // The aggregate is the RESERVATION; a single round may never spend it all.
    for (const call of provider.calls) {
      assert.equal(call.request.maxTokens, 1024, 'each round carries the per-round cap')
    }
  })

  test('a greedy maxRounds is clamped for the reservation exactly as the loop clamps it', async ({
    assert,
  }) => {
    // A host asking for 99 rounds gets MAX_AI_TOOL_ROUNDS. The reservation must use
    // the SAME clamped value: reserving 99 x would let a tenant's quota be held
    // hostage far beyond what the loop can ever spend.
    const { controller, quota } = buildToolChat({ tools: { maxRounds: 99 } })
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    assert.deepEqual(quota.reserves, [1024 * MAX_AI_TOOL_ROUNDS])
  })

  test('a request-level maxTokens still bounds the per-round factor', async ({ assert }) => {
    const { controller, quota } = buildToolChat({ tools: { maxRounds: 2 } })
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { ...toolChatBody, maxTokens: 100 },
    })

    await controller.chat(ctx)

    assert.deepEqual(quota.reserves, [200], 'the aggregate scales the CLAMPED per-round cap')
  })

  test('a greedy request maxTokens is clamped before it is multiplied', async ({ assert }) => {
    // The config ceiling applies FIRST; a greedy request must not multiply an
    // unclamped number into a huge reservation.
    const { controller, quota } = buildToolChat({ tools: { maxRounds: 2 } })
    const { ctx } = fakeHttpContext({
      tenant: fakeTenant,
      body: { ...toolChatBody, maxTokens: 999_999 },
    })

    await controller.chat(ctx)

    assert.deepEqual(quota.reserves, [2048], 'DEFAULT_AI_MAX_TOKENS bounds it, then x maxRounds')
  })
})
