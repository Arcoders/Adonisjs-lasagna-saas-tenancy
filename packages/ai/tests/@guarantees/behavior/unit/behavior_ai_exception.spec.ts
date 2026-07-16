import { test } from '@japa/runner'
import AIException, { AI_ERROR_CODES } from '../../../../src/exceptions/ai_exception.js'

test.group('AIException', () => {
  test('carries a stable code and a pinned HTTP status', ({ assert }) => {
    assert.equal(new AIException('over_budget', 'x').httpStatus, 402)
    assert.equal(new AIException('rate_limited', 'x').httpStatus, 429)
    assert.equal(new AIException('rate_limit_unavailable', 'x').httpStatus, 503)
    assert.equal(new AIException('provider_unavailable', 'x').httpStatus, 503)
    assert.equal(new AIException('provider_not_allowed', 'x').httpStatus, 403)
  })

  test('classifies fatal vs retryable', ({ assert }) => {
    // Retryable: transient conditions.
    for (const code of [
      'provider_unavailable',
      'rate_limited',
      'rate_limit_unavailable',
    ] as const) {
      assert.isTrue(new AIException(code, 'x').isRetryable(), `${code} should be retryable`)
    }
    // Fatal: config / allow-list / budget / BYOK-endpoint rejections.
    for (const code of [
      'over_budget',
      'config_missing',
      'provider_not_allowed',
      'byok_endpoint_blocked',
    ] as const) {
      assert.isFalse(new AIException(code, 'x').isRetryable(), `${code} should be fatal`)
    }
  })

  test('never puts the message on the code and keeps codes closed', ({ assert }) => {
    // Every declared code has a status mapping (no missing arm).
    for (const code of AI_ERROR_CODES) {
      assert.isNumber(new AIException(code, 'safe message').httpStatus)
    }
    const err = new AIException('config_missing', 'a short log-safe string', {
      cause: new Error('raw'),
    })
    assert.equal(err.aiCode, 'config_missing')
    assert.instanceOf(err.originalError, Error)
  })
})
