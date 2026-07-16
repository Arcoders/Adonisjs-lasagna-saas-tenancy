/**
 * The Stripe API version this package is built and tested against. Stripe pins
 * exactly one version per SDK major, so bumping the `stripe` peer dependency
 * means bumping this constant to the new `Stripe.LatestApiVersion`. It lives in
 * one place so the billing service and the test-webhook command cannot drift
 * apart (which is what happened before, with the literal duplicated in both).
 */
export const DEFAULT_STRIPE_API_VERSION = '2026-05-27.dahlia'
