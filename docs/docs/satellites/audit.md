---
title: Audit logs
description: Structured per-tenant audit trail. Queryable by date range, indexed by (tenant_id, created_at).
---

# Audit logs

Records every state change Lasagna makes; and every change you ask
it to record; with actor, payload, and IP address. Queryable by
date range via the admin REST API.

## What gets recorded automatically

- Tenant lifecycle (`created`, `activated`, `suspended`,
  `soft_deleted`, `restored`, `purged`).
- Webhook subscription / delivery state changes.
- Branding updates (with the encrypted fields redacted).
- SSO config updates.
- Impersonation grants and revocations.
- Quota threshold breaches.

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
`(tenant_id, created_at)` index; no `OFFSET` cost regardless of how
many rows the tenant has.

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
