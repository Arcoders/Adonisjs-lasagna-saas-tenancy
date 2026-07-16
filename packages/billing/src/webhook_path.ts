/**
 * Resolve the billing webhook mount path: an explicit option, else
 * `config.billing.webhook.path`, else the provider-neutral default
 * `'/webhooks/billing'`. Billing supports Stripe, Paddle, and Lemon Squeezy, so
 * the default carries no provider branding.
 *
 * Kept in its own module (no `router` import) so the default is unit-testable
 * without booting the Adonis router service.
 */
export function resolveBillingWebhookPath(
  options: { path?: string },
  billingConfig?: { webhook?: { path?: string } }
): string {
  return options.path ?? billingConfig?.webhook?.path ?? '/webhooks/billing'
}
