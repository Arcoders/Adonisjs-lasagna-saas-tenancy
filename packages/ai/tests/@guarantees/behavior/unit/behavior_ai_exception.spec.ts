import { test } from '@japa/runner'
import AIException, {
  AI_ERROR_CODES,
  type AIErrorCode,
} from '../../../../src/exceptions/ai_exception.js'

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

  test('every code has an explicit fatal/retryable classification (RETRYABILITY totality)', ({
    assert,
  }) => {
    // RETRYABILITY is now a Record<AIErrorCode, 'fatal'|'retryable'> total over the
    // union, so a new code without a classification is a COMPILE error (it no longer
    // silently defaults to retryable, the footgun the old hand-maintained Set carried).
    // This runtime mirror still earns its place: it pins the exact isRetryable() value
    // for each code, and in particular nails the three Phase 3a codes whose neighbours
    // classify oppositely: a missing (`tool_confirmation_required`) and a bad
    // (`tool_confirmation_invalid`) confirmation are FATAL (re-sending the identical
    // request cannot help), while the ledger being unreachable (`tool_action_unavailable`)
    // is RETRYABLE (nothing is wrong with the request; retry once it recovers).
    const RETRYABLE: Record<AIErrorCode, boolean> = {
      provider_unavailable: true,
      provider_not_allowed: false,
      over_budget: false,
      rate_limited: true,
      rate_limit_unavailable: true,
      config_missing: false,
      byok_endpoint_blocked: false,
      invalid_request: false,
      rowscope_unsupported: false,
      dimension_mismatch: false,
      embedding_quota_exhausted: false,
      tenant_scope_mismatch: false,
      vector_store_unavailable: true,
      doc_fetch_blocked: false,
      ingestion_denied: false,
      retrieval_denied: false,
      audit_write_failed: true,
      memory_session_invalid: false,
      residency_denied: false,
      tool_unknown: false,
      tool_denied: false,
      tool_input_invalid: false,
      tool_action_disabled: false,
      tool_budget_exhausted: false,
      too_many_concurrent: false,
      tool_confirmation_required: false,
      tool_confirmation_invalid: false,
      tool_action_unavailable: true,
    }

    // The table covers EXACTLY the code union, so a new code cannot ship without a
    // deliberate fatal/retryable decision here.
    assert.deepEqual(
      Object.keys(RETRYABLE).sort(),
      [...AI_ERROR_CODES].sort(),
      'every AIErrorCode needs an explicit fatal/retryable classification'
    )
    // And each code's runtime classification matches the pinned one.
    for (const code of AI_ERROR_CODES) {
      assert.equal(
        new AIException(code, 'x').isRetryable(),
        RETRYABLE[code],
        `${code} fatal/retryable classification drifted`
      )
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
