# v1.0 Audit — Findings

Numbered findings from the documentation-truthfulness audit. Each links the matrix claim
IDs it affects. Severity: **HIGH** = a user relying on the claim could be harmed;
**MED** = misleading; **LOW** = imprecise.

Resolution legend: `code-fix` (behavior brought up to the documented intent, with a
regression test), `doc-fix` (claim rewritten to match deliberate behavior), `test-fix`
(test strengthened to actually prove the claim).

---

## F-1: docs reference a `compose.test.yml` that does not exist

- **Claims:** [contrib#2], [showcase#3], [test#24]
- **Severity:** MED (copy-pasting the documented command fails immediately)
- **Doc text:** `docker compose -f compose.test.yml up -d` (contributing.md, showcase.md, testing.md)
- **Reality:** no `compose.test.yml` / `compose*.yml` anywhere in the repo. The infra file is
  `examples/api/docker-compose.yml` (default name; `docker compose up -d` from `examples/api`,
  or `npm run infra:up`). Verified by glob over the whole tree on 2026-06-10.
- **Resolution:** doc-fix — point all three pages at the real file/commands. (A code-fix
  alternative — adding a root-level `compose.test.yml` — would duplicate infra definitions;
  the example-app compose is the canonical one.)
- **Status:** open

## F-2: quota concurrency spec is weaker than the documented guarantee

- **Claims:** [why#4], [security#6], [security#17]
- **Severity:** MED (the guarantee is documented as exact; the test tolerates under-grant and
  still carries the pre-Lua "near-atomic" caveat in its header)
- **Doc text:** "50 parallel callers against limit=10 produce exactly ten successes and forty
  QuotaExceededException. No race window." (why.md)
- **Reality:** `QuotaService.consume()` is single-EVAL Lua (atomic). The spec
  `packages/core/tests/integration/services/quota_concurrency.spec.ts` asserts only
  `isAtMost(fulfilled, limit)` / `isAtLeast(quotaExceeded, parallelism - limit)` and its
  comment block still describes the outdated "near-atomic" caveat.
- **Resolution:** test-fix (T0) — tighten to exact equality, delete the stale comments.
  Plus doc-fix: one-sentence qualifier that enforcement requires Redis (consume() is
  fail-open on Redis outage by default per `resilience.redis.quota`).
- **Status:** open

## F-3: security.md describes the rate-limit failure policy incorrectly

- **Claims:** [security#13] vs [why#8]
- **Severity:** MED (two pages disagree; the security page's status-code framing is wrong)
- **Doc text:** "The host decides whether that maps to fail-open (502) or fail-closed (429)"
  (security.md:48)
- **Reality:** `RateLimitMiddleware` defaults `failOpen: false` and throws
  `RateLimitUnavailableException` on Redis outage (5xx, not 429); `failOpen: true` lets the
  request proceed (no status at all). why.md's "Redis down means 503, never silent
  fail-open; opt into failOpen: true" matches the code.
- **Resolution:** doc-fix — rewrite security.md:48 to match why.md and the actual exception
  semantics. Verify the exception's HTTP status in the spec while editing.
- **Status:** open

## F-4: `backoffice:setup` discards the underlying migration error

- **Claims:** [quickstart#3] ("Idempotent; re-run any time" — when it *does* fail, the
  operator gets no diagnostic)
- **Severity:** MED (operational diagnosability; hit in practice during this audit's
  baseline: the only output was "Backoffice migration failed" while the real error was
  `relation "tenants" already exists`)
- **Reality:** `packages/core/src/commands/setup_backoffice.ts:32-35` checks
  `migrator.status === 'error'` and logs a generic line; `migrator.error` (the actual
  failure) is never surfaced. Running `migration:run --connection=backoffice` by hand was
  required to see the cause.
- **Resolution:** code-fix — log the migration file name + underlying error message when
  the runner reports `error`. Consider a hint pointing at the per-file statuses
  (`migrator.migratedFiles`).
- **Status:** open

## F-5: security.md's seven "failure modes" GitHub links 404 after the monorepo restructure

- **Claims:** [security#14..20]
- **Severity:** LOW (the specs exist and match their descriptions; only the URLs are stale)
- **Doc text:** links point at `blob/master/tests/integration/...`
- **Reality:** the specs live at `packages/core/tests/integration/...` since the core moved
  into `packages/core` for Changesets.
- **Resolution:** doc-fix — update the seven URLs (and any other `blob/master/tests/` or
  `blob/master/src/` links across the docs site) to the `packages/core/` paths.
- **Status:** open

## F-6: "111-test e2e suite" count has drifted

- **Claims:** [showcase#2], [test#23]
- **Severity:** LOW (undersells; exact counts rot)
- **Reality:** the example-app e2e suite is 125 tests as of 2026-06-10 (full local run:
  125 passed).
- **Resolution:** doc-fix — update or de-precision the number in showcase.md and
  testing.md.
- **Status:** open
