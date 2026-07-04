# The Data-Protection Satellites: Design Bundle

STATUS: This is DESIGN and study material, not execution. Nothing here is implemented. Lasagna 1.0
is not yet released, and none of these three satellites ships until it is. The names, the decisions,
and the seam verdicts in these documents may still change; only the frozen core of `00-foundation.md`
is settled (and even that is settled only relative to the other four docs, not relative to code).
These docs also stand PENDING LEGAL ADVICE: they map mechanisms to Ley 09-08 / CNDP and GDPR
requirements, but that mapping is an engineering study, not a legal opinion, and the operator's
counsel has the final word on whether any of it is fit for purpose.

## The framing principle

Compliance is a property of the OPERATOR (the data controller), never of a library. Lasagna ships
MECHANISMS; the operator owns compliance. No document here claims "GDPR compliant", "SOC2 compliant",
or "Ley 09-08 compliant". Crypto and vault are mechanisms with no policy. Governance carries the
policy the operator declares. None of them decides on the operator's behalf whether a given
processing activity is lawful. Every doc closes with an explicit honesty bound stating what its
mechanism does NOT guarantee.

## The four documents

Read in this order. The build order and the boot-order dependency DAG are the same:
`crypto -> vault -> governance`. Crypto's provider boots first because vault encrypts blobs with
crypto's DEKs, and governance gates crypto's shred and consumes vault's categories.

| # | Doc | One line |
|---|---|---|
| 0 | [`00-foundation.md`](./00-foundation.md) | The constitution: the shared KEK/DEK key hierarchy, the one WORM ledger, the legalBasis-gates-erasability rule, the honesty bound, the reused-seam verdicts, and the section template all three satellite docs are measured against. Where a satellite doc disagrees with this file, this file is right. |
| 1 | [`01-crypto.md`](./01-crypto.md) | `@adonisjs-lasagna/crypto` (MECHANISM, fields): field encryption, deterministic search HMAC, the KEK/DEK-per-`(subject x category)` hierarchy, and the O(1) crypto-shred. Builds first; owns the key hierarchy the other two consume. |
| 2 | [`02-vault.md`](./02-vault.md) | `@adonisjs-lasagna/vault` (MECHANISM, blobs): per-tenant object storage, encrypt-before-upload under crypto's DEK, signed and expiring URLs, audited access. Builds second; reuses crypto for at-rest encryption, so a shred kills blobs too. |
| 3 | [`03-governance.md`](./03-governance.md) | `@adonisjs-lasagna/governance` (POLICY): category registry, consent ledger, DSAR/ARCO orchestration, retention jobs, and the shared WORM ledger. Builds last; declares the categories and legal bases that gate crypto's shred and drive vault's residency decisions. |

The dependency DAG is one-way (`crypto` never imports `governance`); governance's runtime data flow
back into crypto (legalBasis feeds erasability) is a data flow, not a package edge, so the DAG has no
cycle.

## Open decisions (owned by the user)

These are the choices the foundation deliberately leaves open. Each satellite doc's Open Decisions
section restates the ones it touches; they are resolved by the user, not by the library.

1. **Satellite names.**
   - `vault` collides with HashiCorp Vault (a KMS product, and one of our own KeyProvider backends).
     Alternatives on the table: `documents`, `objects`, `locker`. Open.
   - `governance` vs keeping the name `compliance`. Open, and coupled to decision 2.
2. **Graduate vs extend core compliance.** Either GRADUATE the core compliance tooling
   (`tenant_gdpr_anonymize`, `compliance_report_service`, the `anonymize` hook, `tenant_audit_export`)
   into governance, or EXTEND it in place and have governance build on top. Pick exactly ONE, to avoid
   two anonymization engines. The foundation assumes one engine either way; it does not pick which.
3. **KeyProvider default backend.** The pluggable KeyProvider is settled; the DEFAULT for a fresh
   install is not. Options: env-derived (zero-config, dev-grade), or require an explicit KMS binding
   (safer, higher friction). Prod is KMS or HashiCorp Vault regardless.
4. **One-bucket-per-tenant vs shared-bucket-with-tenant-prefix (vault).** `tenantDisk()` gives the
   shared-prefix model for free (`tenants/{id}/`). Bucket-per-tenant gives harder blast-radius
   isolation at higher operational cost. Open.
5. **App-side encryption vs SSE-KMS (vault).** Effectively forced: per-`(subject x category)` shred
   REQUIRES app-side encryption under the DEK before upload, because bucket-level SSE-KMS cannot
   express per-subject-per-category key destruction. App-side is the design; SSE-KMS may be layered
   underneath as defense-in-depth but cannot be the shred mechanism. The user confirms this framing.
6. **AI ledger migration timing.** Whether AI's `ai_audit_logs` migrates onto the shared WORM ledger
   in the 1.0 window or after. The CONTRACT (governance owns one shared ledger; no forked hash-chains)
   is fixed; only the migration TIMING for the existing AI table is open.
