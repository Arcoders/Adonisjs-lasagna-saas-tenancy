# v1.0 Audit — Verdict

> **Status: IN PROGRESS.** This file is finalized in the last wave of the audit. Until then
> it records methodology and the evidence baseline.

## Methodology

- Every concrete claim in the docs site (`docs/`) gets a row in [matrix.md](matrix.md) —
  1,073 rows across 65 pages (972 from the initial extraction + 101 from the re-sweep of
  pages the extraction skipped).
- **Tier A** rows (guarantees, security, failure modes) are only marked VERIFIED after the
  auditor personally read the cited spec's assertion lines; the Test-evidence column cites
  the verbatim test title.
- **Tier B** rows (existence: config keys, commands, exports, events, exceptions) are
  verified by direct grep/read against the source of truth (`src/types/config.ts`,
  `src/commands/commands.json`, `package.json` exports, `src/events/`, `src/exceptions/`).
- **Tier C** rows (narrative, roadmap, comparisons) get an explicit N/A or judgment
  disposition — no silent skips.
- Problems become numbered findings in [findings.md](findings.md). Per the maintainer's
  decision, confirmed doc-vs-code mismatches where the doc states intended behavior are
  fixed in code (with a regression test); doc rewrites are reserved for deliberately
  configurable/aspirational/external behavior.

## Green baseline (before any audit changes)

Captured 2026-06-10 on branch `LASAGNA-100626/v1-doc-truthfulness-audit`
(forked from `LASAGNA-020626/isolation-hardening-and-benchmarks` @ 461f7f7), Windows 10,
Node 24, local infra via `examples/api/docker-compose.yml` (PG 16 @55432, Redis 7 @56379).

| Suite | Command | Result |
|---|---|---|
| Core unit | `npm run test` | 566 passed (566), 3s |
| Billing unit | `npm run test -w @adonisjs-lasagna/billing` | 40 passed (40) |
| Backup unit | `npm run test -w @adonisjs-lasagna/backup` | 43 passed (43) |
| SSO unit | `npm run test -w @adonisjs-lasagna/sso` | 6 passed (6) |
| Admin unit | `npm run test -w @adonisjs-lasagna/admin` | 5 passed (5) |
| Typecheck | `npm run typecheck` | clean |
| Core integration | `npm run test:integration` | 370 passed, 14 skipped (384), 39s |
| Example e2e | `npx tsx ace.ts test e2e` (examples/api) | 125 passed (125), 58s |

Note: the first e2e attempt failed against a stale dev volume (`relation "tenants" already
exists`) — see finding F-4 for the diagnosability gap it exposed; the suite is green on a
fresh volume.

The 14 skipped integration tests are the `*_real.spec.ts` live-API smokes (Stripe,
mock-OIDC, MinIO S3) that self-skip without their gating env/services; they run in CI.

## Verdict

_To be written in the final wave._

## Residual risks

_To be enumerated in the final wave._
