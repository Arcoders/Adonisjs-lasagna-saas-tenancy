import type Stripe from 'stripe'

/**
 * Re-export of Stripe SDK types so host listeners and controllers don't
 * need a direct `import Stripe from 'stripe'`. Keeps the host's import
 * surface minimal — the `stripe` package is an optional peer dep, and
 * a host that only consumes typed events shouldn't need to install it.
 *
 * Runtime callers (anyone who needs to `new Stripe(...)`) still install
 * the peer dep — types alone don't bring the runtime in.
 */
export type StripeEvent = Stripe.Event
export type StripeSubscription = Stripe.Subscription
export type StripeSubscriptionStatus = Stripe.Subscription.Status
export type StripeCustomer = Stripe.Customer
export type StripeInvoice = Stripe.Invoice
export type StripeCheckoutSession = Stripe.Checkout.Session
export type StripePrice = Stripe.Price
export type StripeProduct = Stripe.Product

export type { BillingConfig } from './config.js'
