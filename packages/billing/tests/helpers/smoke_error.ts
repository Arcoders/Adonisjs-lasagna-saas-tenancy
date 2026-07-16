/**
 * Skip-vs-fail classification for the real-API Stripe smokes.
 *
 * The Test Clock smoke is BLOCKING in CI by design (Stripe is the primary
 * provider, so renewal/dunning regressions must fail the build). But Test
 * Clocks are a fragile Stripe feature: they can wedge, and Stripe shelves them
 * first during an outage. We do not want a Stripe-side hiccup to fail an
 * unrelated PR.
 *
 * `isInfraError` draws the line: a Stripe-side transport/availability failure
 * (or the explicit `StripeInfraUnavailable` sentinel a wedged/timed-out clock
 * throws) is treated as INFRA, so the smoke soft-skips with a loud warning.
 * Everything else is NOT infra and still fails the build: a `@japa`
 * `AssertionError` (a real lifecycle regression), a `TypeError`, or a
 * `StripeInvalidRequestError`/`StripeAuthenticationError` (our own misuse or a
 * bad secret).
 *
 * This module is intentionally dependency-free (no `app`, no Stripe import) so
 * the classifier can be unit-tested deterministically without an Ignitor.
 */

/** Thrown by the smoke's own infra helpers (e.g. a test clock that never becomes ready). */
export class StripeInfraUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StripeInfraUnavailable'
  }
}

/**
 * Stripe SDK error identifiers that mean "Stripe-side / transient", not "our
 * test found a real problem". Stripe attaches the class name on both `.name`
 * and `.type`, so we check both. Deliberately excludes
 * `StripeInvalidRequestError` (4xx = our misuse) and `StripeAuthenticationError`
 * (bad/expired key = fix the secret). Those should fail loudly.
 */
const INFRA_NAMES = new Set([
  'StripeInfraUnavailable',
  'StripeConnectionError',
  'StripeAPIError',
  'StripeRateLimitError',
])

/** True when `err` is a Stripe-side infrastructure failure (soft-skip), false otherwise (fail). */
export function isInfraError(err: unknown): boolean {
  if (err instanceof StripeInfraUnavailable) return true
  const e = err as { name?: unknown; type?: unknown } | null | undefined
  if (e && typeof e.name === 'string' && INFRA_NAMES.has(e.name)) return true
  if (e && typeof e.type === 'string' && INFRA_NAMES.has(e.type)) return true
  return false
}
