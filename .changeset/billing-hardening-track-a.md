---
"@adonisjs-lasagna/billing": minor
---

Billing hardening (Track A): close the real reliability gaps in the billing satellite, additively and with no architecture changes.

- **Multi-provider reconciliation parity.** `tenant:billing:sync` is now driver-neutral: a new capability-gated `subscription_list` (implemented for Stripe, Paddle, and Lemon Squeezy) drives the forward pass for every provider, not just Stripe. A driver without the capability skips the forward pass with an explicit warning; the reverse pass still runs. `tenant:billing:doctor` reports per-provider reconciliation coverage.
- **DLQ inspection.** New read-only `tenant:billing:dlq:list` (`--json`, `--limit`) over the `status='failed'` ledger rows — pairs with `tenant:billing:replay`. No new table.
- **Dead-letter alerting seam.** A runnable demo listener (`examples/api`) escalates payment-related dead-letters, plus documentation of the queue retry/backoff contract (fatal vs retryable; the queue owns max-attempts/backoff).
- **Pricing validation.** New CI-friendly `tenant:billing:pricing:validate` (`--json`, exit 1 on a real misconfiguration; provider price resolution is warn-only and degrades for drivers without `price_lookup`), plus a gated CI job that self-skips without a provider test key.
- **Tenant-state guard.** `syncSubscription` no-ops for a `deleted` tenant whose customer mirror survives a soft status flip — a late/replayed event can't resurrect a plan or quota. Fail-open if the repository is unavailable.
- **Currency consistency guard.** `createCheckoutSession` accepts an optional `currency` and rejects a mismatch with the customer's established currency up front (`currency_mismatch`) instead of a provider-specific error.
- **Tests.** Lemon Squeezy replay-window honesty (identical bodies collapse, distinct-tenant bodies don't), checkout/customer and upgrade-vs-stale-webhook race proofs (the existing guards hold — no optimistic-locking column needed), plus driver `listSubscriptions` pagination and the new commands.
- **Docs.** A cross-linked "Billing satellite failure modes" section in `resilience.md`, with reciprocal links from `gotchas.md` and the billing satellite page.
