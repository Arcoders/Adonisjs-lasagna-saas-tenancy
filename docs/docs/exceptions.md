---
title: Exception reference
description: Every exception the package can throw, with its HTTP status, error code, when it fires, and how to catch it. Import them from @adonisjs-lasagna/saas-tenancy/exceptions.
---

# Exception reference

All exceptions extend AdonisJS's `Exception`, so each carries a stable `status`
and `code`. Import them from the `/exceptions` subpath to catch by type:

```ts
import {
  TenantNotReadyException,
  QuotaExceededException,
  DependencyUnavailableException,
} from '@adonisjs-lasagna/saas-tenancy/exceptions'
```

AdonisJS renders the `status` automatically. Catch by type (or match on `code`)
when you want a custom response.

## Reference table

| Exception | Status | Code | Thrown when |
|---|---|---|---|
| `MissingTenantHeaderException` | `400` | `E_MISSING_TENANT_HEADER` | No tenant id could be resolved from the request (and none from `tenancy.run()`). |
| `TenantHeaderDomainMismatchException` | `400` | `E_TENANT_HEADER_DOMAIN_MISMATCH` | A header-supplied tenant id contradicts the host or custom domain, a possible hijack attempt. |
| `TenantNotFoundException` | `404` | `E_TENANT_NOT_FOUND` | The resolved tenant id doesn't exist in the repository. |
| `CentralRouteViolationException` | `404` | `E_CENTRAL_ROUTE_VIOLATION` | A central-only route was reached in a tenant context (or vice-versa). |
| `TenantSuspendedException` | `403` | `E_TENANT_SUSPENDED` | The tenant exists but is `suspended`. |
| `TenantNotReadyException` | `503` | `E_TENANT_NOT_READY` | The tenant is still `provisioning`, so its schema isn't ready yet. |
| `TenantMaintenanceException` | `503` | `E_TENANT_MAINTENANCE` | The tenant is in maintenance mode. Carries `retryAfterSeconds`. |
| `CircuitOpenException` | `503` | `E_CIRCUIT_OPEN` | The tenant's DB circuit breaker is OPEN, so it fails fast instead of hammering a down database. |
| `RateLimitUnavailableException` | `503` | `E_RATE_LIMIT_UNAVAILABLE` | The rate-limit backend (Redis) errored and the route is **fail-closed**. |
| `DependencyUnavailableException` | `503` | `E_DEPENDENCY_UNAVAILABLE` | A `fail-closed` dependency (Redis/PG/…) errored inside `ResilienceService.run()`. Sets `Retry-After`. Carries `dependency`, `operation`, `tenantId`. |
| `TooManyRequestsException` | `429` | `E_TOO_MANY_REQUESTS` | A request exceeded a `RateLimitMiddleware` window. Sets `Retry-After`. |
| `QuotaExceededException` | `429` | `E_TENANT_QUOTA_EXCEEDED` | `QuotaService.consume()` would exceed the plan limit. Carries `quota`, `limit`, `current`, `attempted`. |
| `TenantConnectionLimitException` | `503` | `E_TENANT_CONNECTION_LIMIT` | `isolation.enforceConnectionCap` is on, the connection budget is exhausted, and every open connection is inside the eviction grace window. |
| `ImpersonationInvalidException` | `401` | `E_IMPERSONATION_TOKEN_INVALID` | An impersonation token failed verification, expired, was revoked, or was presented on a different tenant than it was issued for. |
| `IsolationConfigException` | `500` | `E_ISOLATION_CONFIG` | The isolation configuration is unusable (for example `isolation.driver` names a driver that was never registered). |
| `BillingException` | `400` | `E_BILLING` | A Stripe/billing error. Imported from `@adonisjs-lasagna/billing`. Carries a `billingCode` (see [Billing](./satellites/billing)) and `isRetryable()`. |

## Handling patterns

### Catch by type

```ts
import { QuotaExceededException } from '@adonisjs-lasagna/saas-tenancy/exceptions'

try {
  await quotas.consume(tenant, 'apiRequests', 1)
} catch (err) {
  if (err instanceof QuotaExceededException) {
    return response.tooManyRequests({ quota: err.quota, limit: err.limit })
  }
  throw err
}
```

### Degraded dependencies

When a `fail-closed` dependency is down, `DependencyUnavailableException`
surfaces a clean `503 + Retry-After` instead of a raw driver error. Pair it with
the `DependencyDegraded` event for alerting:

```ts
import emitter from '@adonisjs/core/services/emitter'
import { DependencyDegraded } from '@adonisjs-lasagna/saas-tenancy/events'

emitter.on(DependencyDegraded, ({ payload }) => {
  pager.warn(`dependency ${payload.dependency} degraded on ${payload.operation}`)
})
```

See [Configuration → Resilience](./configuration#resilience-degradation-policy)
for choosing fail-open vs fail-closed per dependency.

### Retry-After aware exceptions

`TenantMaintenanceException`, `TooManyRequestsException`, and
`DependencyUnavailableException` all carry retry hints. Surface them so clients
back off instead of busy-looping.

## Read next

- [Services API](/docs/services); where these exceptions originate.
- [Resilience](/docs/resilience); the policy behind `DependencyUnavailableException`.
- [Troubleshooting](/docs/gotchas); symptoms and fixes when these fire.
