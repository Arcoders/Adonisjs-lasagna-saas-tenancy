# v1.0 Audit — Verdict

> **Status: COMPLETE (2026-06-10).** Verdict at the bottom of this file.

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

## Final suite evidence (after all fixes, 2026-06-10)

| Suite | Result | Delta vs baseline |
|---|---|---|
| Core unit (`npm run test:coverage`) | 577 passed; coverage 50.45% lines / 78.89% branches / 69.55% functions — gate (48/78/68) passed | +11 tests |
| Satellite units (billing/backup/sso/admin) | 40 / 43 / 6 / 5 passed | unchanged |
| Typecheck (core + admin) | clean | — |
| Core integration (`npm run test:integration`) | 388 passed, 14 skipped (`*_real` gated specs; they run in CI) | +18 tests |
| Example e2e | 128 passed | +3 tests |
| Docs site (`npm run docs:build`) | builds clean | — |

## Verdict

**The documentation is now trustworthy — after 32 findings were fixed. It was not before.**

What the audit found, in one paragraph: the *isolation core's hard guarantees were solid
and well-tested* — every security.md guarantee except three test gaps verified down to
assertion level, with the cited specs matching their claims exactly (cross-tenant
concurrency, audit immutability triggers, SSO replay incl. the concurrent case, header/
domain hijack, SSRF encoding classification, quota Lua atomicity). The drift lived almost
entirely in the *narrative and satellite documentation*, which described several designs
that were never built (transparent bootstrapper interception with per-service config
blocks, a single-use GETDEL impersonation grant, auto-generated webhook secrets, a
six-category automatic audit trail, hermetic bootstrapper factories, a `withTenant`
helper) and carried compile-breaking API signatures on five pages (jobs, sso, branding,
webhooks, custom-isolation-driver). Four documented resilience knobs were dead config.
Where the documented behavior was clearly the better intent and cheap to honor, the code
was brought up to the doc (webhook secret generation, `withTenant`, the
`resilience.redis.rateLimit` knob, custom-driver typing, exception exports, error
surfacing in `backoffice:setup`); everywhere else the docs now say exactly what the code
does. Every doc page's claims sit in [matrix.md](matrix.md) with code and test evidence;
all 1,077 rows are dispositioned; no Tier-A row was marked VERIFIED without the auditor
reading the spec's assertions.

## Residual risks (deliberately not papered over)

1. **Roadmapped, not built — now labeled as such in the docs:** per-service bootstrapper
   config/interception (F-22), automatic audit coverage beyond impersonation (F-28),
   `resilience.defaultPolicy` / `redis.cache` / `redis.metrics` (F-32), a replica-lag
   Prometheus metric (F-30). If product wants these, they are feature work.
2. **Verified at existence level only:** deploy artifacts (Dockerfile/compose/Helm render
   was not exercised), benchmark numbers (the suite and baselines exist; results were not
   re-run), CHANGELOG content (historical record).
3. **Locally skipped suites:** the 14 `*_real` integration specs (Stripe live API,
   mock-OIDC, MinIO S3) self-skip without their services; they gate in CI. The final green
   must include a CI run on this branch before merge.
4. **External-system claims (N/A rows):** stancl/NestJS comparison columns, Cloudflare/
   cert-manager recipes, emitter semantics inherited from AdonisJS — out of audit scope.
5. **Stability labels are policy, not proof:** "release candidate" still rests on the two
   stated gates (independent security review, production mileage); this audit is an
   internal review and does not discharge them.
6. **Counts rot:** test counts and check counts in prose were de-precisioned where
   possible, but the comparison table still carries exact numbers (25 events, 33
   commands) that will need upkeep.
