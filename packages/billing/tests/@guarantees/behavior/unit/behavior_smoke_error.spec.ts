import { test } from '@japa/runner'
import { isInfraError, StripeInfraUnavailable } from '../../../helpers/smoke_error.js'

/**
 * The skip-vs-fail decision for the real-API Stripe smokes is logic, so it is
 * tested like logic. A mis-classifier is dangerous in BOTH directions: too
 * loose and a real renewal/dunning regression gets silently soft-skipped; too
 * strict and Stripe-side flakiness fails unrelated PRs. These cases pin both.
 */
test.group('isInfraError — smoke skip-vs-fail classifier', () => {
  test('classifies the explicit StripeInfraUnavailable sentinel as infra (→ soft-skip)', ({
    assert,
  }) => {
    assert.isTrue(isInfraError(new StripeInfraUnavailable('test clock did not become ready')))
  })

  test('classifies Stripe transport/availability errors as infra (→ soft-skip)', ({ assert }) => {
    for (const name of ['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError']) {
      assert.isTrue(isInfraError({ name }), `${name} via .name`)
      assert.isTrue(isInfraError({ type: name }), `${name} via .type`)
    }
    // shaped as the Stripe SDK raises a 5xx
    assert.isTrue(isInfraError({ name: 'StripeAPIError', type: 'StripeAPIError', statusCode: 503 }))
  })

  test('matches the REAL stripe-node error shape (name "Error", class name on .type)', ({
    assert,
  }) => {
    // stripe-node sets `.type = this.constructor.name` but never sets `.name`,
    // so a real error is `{ name: 'Error', type: 'StripeConnectionError' }`. The
    // `.type` branch is what carries production classification.
    assert.isTrue(isInfraError({ name: 'Error', type: 'StripeConnectionError' }))
    assert.isTrue(isInfraError({ name: 'Error', type: 'StripeRateLimitError' }))
    assert.isFalse(isInfraError({ name: 'Error', type: 'StripeInvalidRequestError' }))
  })

  test('does NOT classify a real @japa AssertionError as infra (must still fail the build)', ({
    assert,
  }) => {
    let captured: unknown
    try {
      // exactly the error a failing lifecycle assertion inside the smoke throws
      assert.equal(1, 2)
    } catch (err) {
      captured = err
    }
    assert.exists(captured, 'sanity: the bad assertion threw')
    assert.equal((captured as Error).name, 'AssertionError')
    assert.isFalse(isInfraError(captured), 'an AssertionError must NOT soft-skip')
  })

  test('does NOT classify our-misuse / generic errors as infra (must still fail)', ({ assert }) => {
    assert.isFalse(isInfraError(new TypeError('boom')))
    assert.isFalse(isInfraError(new Error('plain')))
    assert.isFalse(isInfraError({ name: 'StripeInvalidRequestError' }), '4xx = our bug, must fail')
    assert.isFalse(isInfraError({ name: 'StripeAuthenticationError' }), 'bad secret, must fail')
    assert.isFalse(isInfraError(null))
    assert.isFalse(isInfraError(undefined))
    assert.isFalse(isInfraError('a string'))
  })
})
