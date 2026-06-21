---
"@adonisjs-lasagna/billing": minor
---

Billing fiscal features (Track B): opt-in multi-country tax snapshots + an append-only invoice read model. The provider stays the source of truth — we only record what it charged (no local invoice numbering, no tax engine).

**Opt-in, billing-local.** The fiscal DDL ships as separate stubs in `stubs/migrations-fiscal/`, deliberately outside the manifest's `migrations` dir, so the core `--with=` path and the base `configure` never publish them. `node ace configure @adonisjs-lasagna/billing` publishes them only when you opt in — answer yes to the prompt (default no), or set `LASAGNA_BILLING_FISCAL=1` for CI / non-interactive runs. Runtime behaviour is gated by `config.billing.fiscal.enabled`.

- **`country_code`** added to `billing_customers` (ISO 3166-1 alpha-2), populated from the provider customer when fiscal is enabled. Reversible migration.
- **Tax snapshot.** The neutral `Invoice` now carries optional `subtotal` / `tax` / `total` (integer minor units), mapped from Stripe / Paddle / Lemon Squeezy when the provider breaks them out. `PaymentSucceeded` carries `tax` / `total`. Stripe checkout passes `automatic_tax` when `config.billing.fiscal.automaticTax` is set.
- **Invoice read model.** New append-only `billing_invoice_snapshots` table, written on `invoice.payment_succeeded` when fiscal is enabled (idempotent via `UNIQUE (provider, provider_invoice_id)`). Reversible migration.
- **Read-through endpoints.** A new exported `BillingInvoiceController` (`index` + `pdf`) the host mounts behind its own auth + tenant middleware (like checkout/portal); lists the tenant's snapshots and redirects to the provider-hosted PDF. The package never auto-registers unauthenticated tenant-data routes.
- **Currency guard.** `createCheckoutSession` accepts an optional `currency` and rejects a mismatch with the customer's established currency (`currency_mismatch`).

All amounts are integer minor units; nothing fabricates tax. Live VAT/sales-tax behaviour depends on the provider account (e.g. Stripe Tax) and is verified manually / via the gated real-API smokes; the mapping and snapshot write are covered by unit + integration tests.
