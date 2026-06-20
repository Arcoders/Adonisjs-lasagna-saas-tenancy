---
"@adonisjs-lasagna/saas-tenancy": minor
---

Add compliance tooling that maps Lasagna's existing isolation, audit, encryption, and
retention features to SOC2, GDPR, ISO 27001, and HIPAA controls — positioning the package as
compliance-ready without claiming certification (that stays the deploying organization's).

Three new ace commands ship in core:

- `tenant:audit:export` — stream the immutable audit log to JSON or CSV for auditors and GDPR
  Art.15/Art.20. Filters by `--tenant`, `--from`/`--to`, writes to `--out` or stdout, and
  streams batch-by-batch so a deep history is never materialized in memory.
- `tenant:gdpr:anonymize <tenantId>` — GDPR Art.17 erasure-by-anonymization via a new
  `config.compliance.anonymize` seam (`TenantAnonymizer`, exported from
  `@adonisjs-lasagna/saas-tenancy/types`). The package never touches your models: the host
  decides what PII is and how to mask it; the command runs it inside `tenancy.run(tenant)`,
  records a `gdpr.anonymize` entry in the immutable audit log, and dispatches a new
  `TenantAnonymized` event. It fails loudly when the seam is unset.
- `tenant:compliance:report` — introspects real posture (immutability triggers installed,
  `APP_KEY` set, active isolation driver, `authorizeTenantAccess` wired, retention configured)
  and maps each finding to controls. It is an extensible registry modelled on
  `tenant:doctor` (a new `ComplianceReportService` with `register()`/built-in controls), so
  satellites can contribute their own controls on boot. `--framework`, `--control`, `--json`,
  and `--strict` (exit 1 on action-needed, for CI gates).

Ships a new "Compliance (SOC2 & GDPR)" docs page with the control matrix, an explicit
"what's encrypted at rest (and what isn't)" table, and a worked anonymizer example, plus
cross-links from the Security and Audit pages. No behavior changes for existing installs; all
three commands and the config seam are additive.
