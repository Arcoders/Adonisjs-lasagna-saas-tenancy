---
title: Audit logs
description: Structured per-tenant audit trail. Queryable by date range, indexed by (tenant_id, created_at).
---

# Audit logs

A tamper-proof, per-tenant audit trail with actor, payload, and IP
address — queryable by date range via the admin REST API. The
package provides the storage, the immutability guarantees, and the
`AuditLogService.log()` API; *what* gets recorded is mostly your
call.

## What gets recorded automatically

- Impersonation sessions: `admin:impersonate:start`,
  `admin:impersonate:first-use`, and `admin:impersonate:stop`.

That is the only built-in writer today. Everything else — tenant
lifecycle transitions, webhook changes, branding/SSO updates, quota
breaches — is recorded by *your* code via `audit.log()`; the
[lifecycle hooks](/docs/hooks) and [events](/docs/events) give you
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
three PostgreSQL triggers — `BEFORE UPDATE`, `BEFORE DELETE`, and
`BEFORE TRUNCATE` — that all `RAISE EXCEPTION`. **Audit rows are
append-only at the database level**: a compromised tenant role or
buggy controller cannot rewrite or erase evidence.

## Recording your own events

```ts
import { AuditLogService } from '@adonisjs-lasagna/saas-tenancy/services'

const audit = await app.container.make(AuditLogService)

await audit.log({
  tenantId: tenant.id,
  actorType: 'admin',           // 'admin' | 'system'
  actorId: user.id,
  action: 'subscription.upgraded',
  metadata: { fromPlan: 'starter', toPlan: 'pro' },
  ipAddress: request.ip(),
})
```

## Querying

```bash
# REST: /admin/multitenancy/tenants/<id>/audit-logs?from=2026-04-01&to=2026-04-30
curl -H "x-admin-token: $TOKEN" \
  "https://app.example.com/admin/multitenancy/tenants/$ID/audit-logs?from=2026-04-01&to=2026-04-30"
```

The `from` and `to` parameters expect ISO 8601 dates and rely on the
`(tenant_id, created_at)` index. Results are page/limit paginated
(limit capped at 200) — narrow the date range for tenants with very
deep histories rather than walking far pages.

## Retention

Because the table is append-only, you can't `DELETE FROM
tenant_audit_logs` directly — the trigger will reject it. Two
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

**Or partition by month** and `DETACH` + `DROP` old partitions —
`DROP TABLE` doesn't fire the row-level triggers, so the partition
itself can be archived to S3 and dropped without disabling
anything. This is the recommended pattern for high-volume tenants.

Most teams ship audit rows to a long-term store (Loki, BigQuery,
S3) and prune the operational table to 90 days. The package gives
you a queryable database; the long-term archive is your job.


## Read next

- [Security](/security); the append-only guarantees at the SQL level.
- [Compliance (SOC2 & GDPR)](/compliance); exporting the trail for auditors (`tenant:audit:export`) and how it maps to controls.
- [Admin REST API](/docs/admin-rest-api); reading audit logs over HTTP.
- [Satellites](/docs/satellites/); the rest of the opt-in features.
