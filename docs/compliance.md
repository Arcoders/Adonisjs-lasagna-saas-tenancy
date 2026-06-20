---
title: Compliance (SOC2 & GDPR)
description: How Lasagna's audit, isolation, encryption, retention, and erasure tooling maps to SOC2, GDPR, ISO 27001, and HIPAA controls — and what the host application still owns.
---

# Compliance: SOC2 & GDPR

<Callout type="warning" title="This is not a certification">
Using Lasagna does <strong>not</strong> make you SOC2 certified or GDPR
compliant. Certification is earned by the <em>organization that deploys the
software</em>, never by a dependency. What Lasagna gives you is the
<strong>controls and the evidence</strong> — immutable audit, encryption of
secrets, tenant isolation, retention, and erasure tooling — so your auditors
have fewer questions and your team designs fewer controls from scratch.
</Callout>

A multi-tenant platform carries a lot of an auditor's checklist. This page maps
common SOC2, GDPR, ISO 27001, and HIPAA controls to the Lasagna feature that
backs them, and is explicit about the line: **what the package enforces** versus
**what stays the host's responsibility** (the same split as the
[Security](/security) guide).

## How to read the matrix

Every row names a control, the Lasagna feature that provides evidence for it, and
what you still own. None of these are turnkey: the package gives you the
primitive; you wire it into your environment and processes.

## SOC2 (Trust Services Criteria)

| Control | Lasagna feature | What you own |
|---|---|---|
| **CC6.1** logical access | [`authorizeTenantAccess`](/security) membership gate + [tenant isolation](/docs/data-isolation) | Identity/membership source, full RBAC |
| **CC6.7** encryption at rest | Stored secrets encrypted AES-256-GCM; rotation via `tenant:secrets:reencrypt` | App-data encryption + backup/volume encryption |
| **CC7.2** system monitoring | [Append-only audit log](/docs/satellites/audit) + `tenant:doctor` + [metrics/health](/docs/health) | Alerting, SIEM, on-call |
| **CC7.3** evaluating events | `tenant:audit:export` (evidence for investigators) | Investigation & response process |
| **CC8.1** change management | Versioned per-tenant migrations + `doctor` schema-drift | CI/CD approvals, change records |
| **C1** confidentiality | [Isolation drivers](/docs/data-isolation) (`schema-pg` / `database-pg` / `rowscope-pg`) | Data classification |

## GDPR

| Article | Lasagna feature | What you own |
|---|---|---|
| **Art.15** right of access | `tenant:backup` + `tenant:audit:export` | Mapping exports to the data-subject response |
| **Art.17** right to erasure | `tenant:destroy` / `tenant:purge-expired` (full delete) **or** `tenant:gdpr:anonymize` (mask when legal retention forbids deletion) | The anonymizer seam over your PII (below) |
| **Art.20** portability | `tenant:backup` + `tenant:import` (standard `pg_dump` format) | Transforming to the format the subject requires |
| **Art.30** records of processing | [Append-only audit log](/docs/satellites/audit) | Which events you record via `audit.log()` |
| **Art.32** security of processing | Secret encryption + isolation + immutable audit | TLS, app-data encryption, key management |
| **Data residency** | `database-pg` driver (a database per tenant) | Physical region/placement of the database |

## Also maps to (by analogy)

These frameworks share the same technical safeguards. The mapping is for
orientation; it is not a claim of certification.

- **ISO 27001 Annex A (2022):** A.5.15 access control ↔ `authorizeTenantAccess`;
  A.8.24 cryptography ↔ secret encryption; A.8.15 logging ↔ audit log; A.8.10
  information deletion ↔ `tenant:purge-expired`; A.8.11 data masking ↔
  `tenant:gdpr:anonymize`.
- **HIPAA technical safeguards:** §164.312(a) access control ↔
  `authorizeTenantAccess` + isolation; (a)(2)(iv) encryption ↔ secret
  encryption; (b) audit controls ↔ audit log; (c)(1) integrity ↔ immutability
  triggers; (e) transmission security ↔ TLS (host).

## What's encrypted at rest (and what isn't)

<Callout type="warning" title="Encryption covers secrets, not application data">
Do not read "secrets are encrypted" as "everything is encrypted at rest."
Lasagna encrypts <strong>stored secrets</strong> only.
</Callout>

| Encrypted by the package | NOT encrypted by the package |
|---|---|
| Webhook signing secrets (`tenant_webhooks.secret`) | Tenant/business columns in your models |
| SSO `client_secret` (`tenant_sso_configs.client_secret`) | `pg_dump` backup archives at rest |
| (AES-256-GCM, key derived from `APP_KEY`, `enc_v1:` prefix) | Files on disk / object storage |

To encrypt application data at rest, that is the host's job: encrypt the volume
or disk, use database-level transparent encryption (TDE), or column-level
encryption (`pgcrypto`). Encrypt backup storage (the volume or the S3 bucket)
separately. Rotating `APP_KEY` re-keys stored secrets — run
`OLD_APP_KEY=<previous> node ace tenant:secrets:reencrypt` as part of any
rotation.

## Implementing the GDPR anonymizer

`tenant:gdpr:anonymize` is a **seam**, not a turnkey command. The package never
imports your models, so **you** decide what counts as PII and how to mask it. If
`config.compliance.anonymize` is not set, the command fails loudly — that means
your implementation is missing, not that the command is broken.

Use it for Art.17 erasure-by-anonymization when a legal retention obligation
means you must keep the row (an invoice, a financial record) but strip the
personal data. When you can delete everything, prefer `tenant:destroy`.

The seam runs inside `tenancy.run(tenant)`, so your model queries hit the
tenant's own schema. Honor `dryRun` (count, don't write) and return `{ affected }`
for the audit trail:

```ts
// config/multitenancy.ts
import type { TenantAnonymizer } from '@adonisjs-lasagna/saas-tenancy/types'

export default {
  // ...
  compliance: {
    anonymize: (async ({ tenant, dryRun }) => {
      // Your models — never a package import.
      const { default: User } = await import('#models/user')
      const users = await User.query()
      if (dryRun) return { affected: users.length }

      for (const u of users) {
        u.email = `redacted+${u.id}@anon.invalid` // deterministic, keeps row uniqueness
        u.fullName = 'Redacted'
        u.phone = null
        u.addressLine = null
        await u.save() // keeps created_at, invoices, etc. for legal retention
      }
      return { affected: users.length }
    }) satisfies TenantAnonymizer,
  },
}
```

```bash
# Preview the blast radius first — writes nothing.
node ace tenant:gdpr:anonymize <tenantId> --dry-run --reason="DSAR #1234"

# Execute, recording the reason + affected count in the immutable audit log.
node ace tenant:gdpr:anonymize <tenantId> --reason="DSAR #1234"
```

Every run (success, dry-run, or failure) writes a `gdpr.anonymize` entry to the
append-only audit log — your evidence that the erasure right was exercised.
Advanced patterns: salted deterministic hashing (to preserve joins), an identity
tombstone, or fanning out to downstream copies via the `TenantAnonymized` event.

## Recipes

**Right to erasure (Art.17).** Full delete: `tenant:destroy <id>` then
`tenant:purge-expired` after the retention window. Anonymize-in-place (legal
retention): `tenant:gdpr:anonymize <id>` with the seam above.

**Right of access & portability (Art.15 / Art.20).** `tenant:backup --tenant=<id>`
for the data, `tenant:audit:export --tenant=<id>` for the activity trail; restore
elsewhere with `tenant:import`.

**Evidence for an auditor.** `tenant:compliance:report --json` for the posture
snapshot, `tenant:audit:export` for the activity record. Gate CI with
`tenant:compliance:report --strict`.

**Retention.** Set `softDelete.retentionDays` explicitly and schedule
`tenant:purge-expired` on a cron. Audit-log retention runs under a separate
privileged role — see [Audit logs → Retention](/docs/satellites/audit#retention).

**Data residency.** Use the [`database-pg`](/docs/data-isolation/database-pg)
driver to place each tenant in its own database (and region).

## The compliance report

`tenant:compliance:report` introspects real state — it checks the audit
immutability triggers are installed, `APP_KEY` is set, which isolation driver is
active, whether `authorizeTenantAccess` is wired, and whether a retention window
is configured — and maps each to the controls above.

It is a **registry of controls**, like `tenant:doctor`'s checks: satellites
register their own controls on boot, so the report stays current as you add
features. `--strict` exits non-zero when any control is `action-needed`, which
makes it a CI gate.

```bash
node ace tenant:compliance:report                 # table, all frameworks
node ace tenant:compliance:report --framework=gdpr
node ace tenant:compliance:report --json --strict # CI gate
node ace tenant:compliance:report --control=list  # enumerate controls
```

## Read next

- [Security](/security) — the guarantees these controls build on.
- [Audit logs](/docs/satellites/audit) — append-only enforcement and retention.
- [Data isolation](/docs/data-isolation) — choosing schema/database/row scoping.
- [Production checklist](/docs/production-checklist) — the hardening runbook.
