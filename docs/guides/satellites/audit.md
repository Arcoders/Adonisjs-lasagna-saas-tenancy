---
title: Audit logs
description: Structured per-tenant audit trail. Queryable by date range, indexed by (tenant_id, created_at).
---

# Audit logs

A tamper-proof, per-tenant audit trail with actor, payload, and IP
address, queryable by date range via the admin REST API. The
package provides the storage, the immutability guarantees, and the
`AuditLogService.log()` API; *what* gets recorded is mostly your
call.

## What gets recorded automatically

- Impersonation sessions: `admin:impersonate:start`,
  `admin:impersonate:first-use`, and `admin:impersonate:stop`.

That is the only built-in writer today. Everything else (tenant
lifecycle transitions, webhook changes, branding/SSO updates, quota
breaches) is recorded by *your* code via `audit.log()`; the
[lifecycle hooks](/reference/hooks) and [events](/reference/events) give you
clean attachment points:

```ts
// config/multitenancy.ts — audit every provision/destroy
hooks: {
  afterProvision: async ({ tenant }) => {
    const audit = await app.container.make(AuditLogService)
    await audit.log({ tenantId: tenant.id, actorType: 'system', action: 'tenant.provisioned' })
  },
}
```

You opt-in via `node ace configure @adonisjs-lasagna/saas-tenancy
--with=audit`. The migration creates `tenant_audit_logs` in the
backoffice schema with an index on `(tenant_id, created_at)` AND
three PostgreSQL triggers (`BEFORE UPDATE`, `BEFORE DELETE`, and
`BEFORE TRUNCATE`) that all `RAISE EXCEPTION`. **Audit rows are
append-only at the database level**: a compromised tenant role or
buggy controller cannot rewrite or erase evidence.

## Recording your own events

```ts
import { AuditLogService } from '@adonisjs-lasagna/saas-tenancy/services'

const audit = await app.container.make(AuditLogService)

await audit.log({
  tenantId: tenant.id,
  actorType: 'admin',           // AuditActorType: 'admin' | 'system'
  actorId: user.id,
  action: 'subscription.upgraded',
  metadata: { fromPlan: 'starter', toPlan: 'pro' },
  ipAddress: request.ip(),
})
```

`actorType` is the exported `AuditActorType` (`'admin' | 'system'`, from
`@adonisjs-lasagna/saas-tenancy/models/satellites`): `'admin'` for an operator action,
`'system'` for one the platform took on its own.

## Querying

```bash
# REST: /admin/multitenancy/tenants/<id>/audit-logs?from=2026-04-01&to=2026-04-30
curl -H "x-admin-token: $TOKEN" \
  "https://app.example.com/admin/multitenancy/tenants/$ID/audit-logs?from=2026-04-01&to=2026-04-30"
```

The `from` and `to` parameters expect ISO 8601 dates and rely on the
`(tenant_id, created_at)` index. Results are page/limit paginated
(limit capped at 200), so narrow the date range for tenants with very
deep histories rather than walking far pages.

## Retention

Because the table is append-only, you can't `DELETE FROM
tenant_audit_logs` directly; the trigger will reject it. Two
supported patterns:

**Ship to a long-term store, then purge under controlled access.**
A privileged retention job temporarily disables the delete trigger,
prunes by `created_at`, then re-enables it. Run as a database role
that is NOT the application role, so a compromised app process
cannot reach this codepath:

```sql
-- Run as a retention role distinct from the app role.
ALTER TABLE backoffice.tenant_audit_logs DISABLE TRIGGER tenant_audit_logs_no_delete;
DELETE FROM backoffice.tenant_audit_logs WHERE created_at < now() - interval '90 days';
ALTER TABLE backoffice.tenant_audit_logs ENABLE TRIGGER tenant_audit_logs_no_delete;
```

**Or partition by month** and `DETACH` + `DROP` old partitions;
`DROP TABLE` doesn't fire the row-level triggers, so the partition
itself can be archived to S3 and dropped without disabling
anything. This is the recommended pattern for high-volume tenants.

Most teams ship audit rows to a long-term store (Loki, BigQuery,
S3) and prune the operational table to 90 days. The package gives
you a queryable database; the long-term archive is your job.

## Exporting the trail

When an auditor or a GDPR Art.15 / Art.20 request needs the raw trail,
`tenant:audit:export` streams it out as JSON or CSV. It writes in batches, so a
tenant with millions of rows is never held in memory.

```bash
# One tenant, a date window, as CSV, written to a file
node ace tenant:audit:export \
  --tenant=$ID --from=2026-01-01 --to=2026-03-31 \
  --format=csv --out=audit-q1.csv

# Every tenant (including system rows) as JSON, piped to gzip
node ace tenant:audit:export --format=json | gzip > audit-all.json.gz
```

| Flag | Default | Notes |
|---|---|---|
| `--tenant` | all tenants | Omit to export every tenant, including `system` rows. |
| `--from` / `--to` | unbounded | ISO 8601 bounds on `created_at`, inclusive. |
| `--format` | `json` | `json` or `csv`. |
| `--out` | stdout | Write to a file instead. With no `--out`, the data stream is the only stdout output, so it stays pipe-friendly. |

For how the export maps to specific SOC2 and GDPR controls, see
[Compliance](/guides/compliance).

## Extensibility: log destinations

Register an `AuditLogDestination` on `AuditLogDestinationRegistry` (a container
singleton) to fan every audit entry out to an external sink (Datadog, Splunk, an
S3 archive). The canonical `tenant_audit_log` row stays authoritative: it is
written first and returned to the caller, then destinations run best-effort,
isolated and time-bounded. A slow or throwing sink never fails the audited
operation. With none registered, behavior is unchanged. Versioned via
`AUDIT_CONTRACT_VERSION`; see the [Extensibility standard](/guides/extensibility).

## Read next

- [Security](/guides/security); the append-only guarantees at the SQL level.
- [Compliance (SOC2 & GDPR)](/guides/compliance); exporting the trail for auditors (`tenant:audit:export`) and how it maps to controls.
- [Admin REST API](/guides/satellites/admin-rest-api); reading audit logs over HTTP.
- [Production checklist](/reference/production-checklist); the hardening runbook before you ship.
- [Satellites](/guides/satellites/); the rest of the opt-in features.
