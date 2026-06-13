# Coverage matrix

This maps every area from the hardening test brief to the spec(s) that exercise it. The
package already ships a deep suite, so most rows point at existing specs. The rows added by
this effort live under `examples/api/tests/e2e/hardening/` and are marked **(new)**. Where a
guarantee has an authoritative low-level proof and a new end-to-end companion, both are listed.

Path roots:

- `core/` = `packages/core/tests/`
- `e2e/` = `examples/api/tests/e2e/`
- `sso/` = `packages/sso/tests/`

## 1. Provisioning & lifecycle

| Feature                                          | Spec                                                                                                                                 | Key scenario                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Create → `tenant_<uuid>` schema                  | `e2e/hardening/provisioning.spec.ts` **(new)**                                                                                       | schema absent before install, present after               |
| Soft-delete + retention + `tenant:purge-expired` | `e2e/hardening/provisioning.spec.ts` **(new)**, `e2e/full.spec.ts`                                                                   | keepSchema retains; purge with retention 0 drops          |
| Restore a soft-deleted tenant                    | `e2e/hardening/provisioning.spec.ts` **(new)**                                                                                       | restore clears `deleted_at`, data intact                  |
| Clone / backup / restore / import SQL            | `e2e/backups_real.spec.ts`, `e2e/commands_lifecycle.spec.ts`, `core/integration/services/clone.spec.ts`                              | pg_dump/pg_restore round-trips (skip-guarded on pg tools) |
| Concurrent provisioning idempotency              | `e2e/hardening/concurrent_provisioning.spec.ts` **(new)**                                                                            | two installs of one id → one schema, no error             |
| Lifecycle events emitted                         | `e2e/hardening/provisioning.spec.ts` **(new)**, `e2e/lifecycle_events.spec.ts`, `core/integration/events/lifecycle_dispatch.spec.ts` | `tenant.created` audited; event classes dispatched        |
| REPL (`tenant:repl`)                             | command exists (`core/src/commands/tenant_repl.ts`); interactive, not automated                                                      | see MISSING_FEATURES.md                                   |

## 2. Identification & routing

| Feature                                          | Spec                                                                                                | Key scenario                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Header resolver (`x-tenant-id`)                  | `e2e/resolution_strategies.spec.ts`, `e2e/full.spec.ts`                                             | header maps to tenant; missing header → 400                              |
| Subdomain / custom-domain resolvers              | `e2e/resolution_strategies.spec.ts`, `core/integration/middleware/custom_domain_middleware.spec.ts` | hostname maps to tenant                                                  |
| Path / request-data resolvers                    | `core/unit/extensions/tenant_resolver.spec.ts`                                                      | all five strategies dispatch                                             |
| Resolver chain with fallbacks                    | `core/unit/services/resolver_registry.spec.ts`                                                      | chain order respected                                                    |
| Imperative API (`tenancy.run/current/currentId`) | `core/integration/jobs/tenant_context.spec.ts`                                                      | context flows in jobs (note: no `initialize()`, see MISSING_FEATURES.md) |
| `Route.tenant/central/universal`                 | `core/unit/extensions/router_macros.spec.ts`                                                        | macros wrap the right middleware                                         |

## 3. Data isolation (hardening)

| Feature                                    | Spec                                                                                                                                | Key scenario                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Cross-tenant isolation under concurrency   | `core/integration/isolation/cross_tenant_e2e.spec.ts` (authoritative, 5×20), `e2e/hardening/isolation_concurrent.spec.ts` **(new)** | interleaved concurrent writes, direct-DB zero cross-read |
| Pooled-connection reuse safety             | `e2e/hardening/isolation_concurrent.spec.ts` **(new)**, `core/integration/isolation/connection_eviction_safety.spec.ts`             | reused connections never bleed rows                      |
| Schema removed after purge                 | `e2e/hardening/provisioning.spec.ts` **(new)**                                                                                      | `information_schema` empty post-purge                    |
| Soft-deleted data invisible but restorable | `e2e/hardening/provisioning.spec.ts` **(new)**                                                                                      | data returns after restore                               |
| Per-database / row-scope isolation         | `core/integration/isolation/database_pg_crud_isolation.spec.ts`                                                                     | database-pg driver isolation                             |

## 4. Plan & quota enforcement (hardening)

| Feature                                            | Spec                                                                                                                               | Key scenario                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Quota middleware → 429 over limit                  | `e2e/full.spec.ts`, `e2e/hardening/quota_atomicity.spec.ts` **(new)**                                                              | `enforceQuota` rejects with 429 `QUOTA_EXCEEDED`                       |
| Quota atomicity (parallel)                         | `core/integration/services/quota_concurrency.spec.ts` (authoritative, 50 vs 10), `e2e/hardening/quota_atomicity.spec.ts` **(new)** | 50 concurrent, primed to 40/50 → exactly 10 ok / 40 × 429, usage == 50 |
| Different plans, different limits                  | `e2e/hardening/quota_atomicity.spec.ts` **(new)**, `core/unit/services/quota_service.spec.ts`                                      | free=50, pro=10000                                                     |
| Snapshot + rolling counters                        | `core/unit/services/quota_service.spec.ts`                                                                                         | `track` / `setUsage` / `snapshot`                                      |
| Resilience fail-open/closed + `DependencyDegraded` | `core/integration/services/quota_resilience.spec.ts`                                                                               | Redis outage policy                                                    |

## 5. Operational services & satellites

| Feature                                       | Spec                                                                                                                           | Key scenario                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Circuit breaker open / persist / restore      | `core/integration/services/circuit_breaker_service.spec.ts` (authoritative), `e2e/hardening/circuit_breaker.spec.ts` **(new)** | open → 503 fast-fail, sibling unaffected, `cb:state` persisted, reset recovers |
| Read replicas (round-robin / sticky / naming) | `e2e/replicas_strategies.spec.ts`, `core/unit/services/read_replica_service.spec.ts`                                           | sticky routing, deterministic names                                            |
| `tenant:doctor` checks / `--fix` / `--json`   | `e2e/commands_misc.spec.ts`, `e2e/hardening/doctor_json.spec.ts` **(new)**, `core/unit/health/doctor/*`                        | 9 checks; `--fix` closes a circuit; `--json` shape + exit code                 |
| Backups & retention                           | `e2e/backups_real.spec.ts`, `e2e/backups_corruption.spec.ts`                                                                   | dump/restore, checksums, corruption handling                                   |
| Audit immutability                            | `core/integration/satellites/audit_immutability.spec.ts` (authoritative), `e2e/hardening/audit_immutability.spec.ts` **(new)** | UPDATE/DELETE/TRUNCATE blocked; INSERT allowed                                 |
| Webhooks HMAC + retry/backoff                 | `e2e/webhooks_delivery.spec.ts`, `core/integration/billing/webhook_*`                                                          | signed delivery, retry state machine                                           |
| SSO replay (GETDEL) + JWKS                    | `core/integration/services/sso_oidc_flow.spec.ts:291,313` (authoritative), `e2e/hardening/sso_replay.spec.ts` **(new)**        | single-use + concurrent one-winner; atomic GETDEL primitive                    |
| Feature flags / branding                      | `e2e/satellites.spec.ts`, `core/integration/services/feature_flag_service.spec.ts`                                             | per-tenant isolation                                                           |
| Stripe billing                                | `core/integration/billing/*` (25 specs)                                                                                        | subscription sync, idempotency, replay                                         |
| Metrics (Prometheus / OTel)                   | `e2e/full.spec.ts`, `e2e/deployment_probes.spec.ts`, `core/unit/health/metrics_exporter.spec.ts`                               | `/metrics` exposition; tenant labels                                           |
| Health probes (`/livez` `/readyz` `/healthz`) | `e2e/deployment_probes.spec.ts`, `core/integration/health/readyz_http.spec.ts`                                                 | status by system state                                                         |

## 6. Reliability & resilience (hardening)

| Feature                          | Spec                                                                                          | Key scenario                               |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Rate-limit fail-closed → 503     | `core/integration/middleware/rate_limit.spec.ts:93`                                           | Redis down → 503 `RATE_LIMIT_UNAVAILABLE`  |
| Rate-limit fail-open opt-in      | `core/integration/middleware/rate_limit.spec.ts:133`                                          | `failOpen:true` → request passes           |
| Per-dependency resilience policy | `core/integration/services/quota_resilience.spec.ts`, `core/unit/services/resilience.spec.ts` | fail-open vs fail-closed + event           |
| Identifier injection prevention  | `core/unit/services/identifier.spec.ts`, `core/architectural/no_unsafe_raw_sql.spec.ts`       | `assertSafeIdentifier`; CI lint on raw SQL |

## 7. Concurrency & race conditions (hardening)

| Feature                                      | Spec                                                      | Key scenario                                             |
| -------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| Quota atomicity                              | row 4 above                                               | exact counts under 50-way contention                     |
| SSO replay                                   | row 5 above                                               | exactly one concurrent consumer wins                     |
| Concurrent provisioning, no duplicate schema | `e2e/hardening/concurrent_provisioning.spec.ts` **(new)** | idempotent `CREATE SCHEMA IF NOT EXISTS`                 |
| Concurrent backup/restore locking            | `e2e/hardening/backup_lock.spec.ts` **(new)**             | same-tenant op rejected 409, distinct tenants concurrent |

## 8. Context propagation

| Feature                                      | Spec                                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Contextual logger (`tenantId` on every line) | `e2e/contextual_logging.spec.ts`                                                                                     |
| BullMQ job context                           | `core/integration/jobs/tenant_context.spec.ts`, `e2e/queue_jobs.spec.ts`                                             |
| Mail / cache / drive / session per tenant    | `e2e/mail.spec.ts`, `core/unit/services/bootstrappers/*`, `core/integration/services/bootstrapper_isolation.spec.ts` |

## 9. Admin API (OpenAPI 3.1)

| Feature                    | Spec                                                                                                         | Key scenario                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Tenant CRUD over admin API | `e2e/admin_full.spec.ts`, `e2e/hardening/admin_openapi_conformance.spec.ts` **(new)**                        | list/show/activate/suspend/destroy/restore                            |
| Auth fail-closed           | `e2e/hardening/admin_openapi_conformance.spec.ts` **(new)**                                                  | no token → 401 on routes and spec                                     |
| OpenAPI accuracy           | `core/unit/admin/openapi.spec.ts` (router⇄spec), `e2e/hardening/admin_openapi_conformance.spec.ts` **(new)** | 3.1 document, all satellite families declared, live endpoints respond |
| Unknown tenant → 404       | `e2e/hardening/admin_openapi_conformance.spec.ts` **(new)**                                                  | show of random id → 404                                               |

## 10. AdonisJS integration

| Feature                                                           | Spec                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| Middleware registration (quota, guard, etc.)                      | `core/integration/middleware/*`, `core/unit/middleware/*` |
| Provider bindings (`TenantRepositoryContract`, isolation drivers) | `e2e/boot_misconfig.spec.ts`, `core/unit/providers/*`     |
| Route macros + auto-loaded tenant routes                          | `core/unit/extensions/router_macros.spec.ts`              |

## 11. Security hardening

| Feature                          | Spec                                                              | Key scenario                              |
| -------------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| Header-vs-domain hijack (strict) | `core/integration/middleware/header_vs_domain_precedence.spec.ts` | `E_TENANT_HEADER_DOMAIN_MISMATCH` (400)   |
| Cross-tenant leakage             | section 3                                                         | zero cross-reads                          |
| Injection against schema names   | `core/unit/services/identifier.spec.ts`                           | `assertSafeIdentifier` rejects unsafe ids |
