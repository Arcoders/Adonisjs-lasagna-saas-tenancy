# Contributing

Hey, thanks for thinking about contributing! This package is a community effort and we genuinely appreciate every issue, suggestion, and pull request that comes in. Whether you're fixing a typo or adding a whole new feature, you're helping make multi-tenancy on AdonisJS a little bit better for everyone.

This guide walks you through getting set up, making your changes, and getting them merged. If anything here is unclear or out of date, please open an issue and let us know.

---

## Before you start

A few things worth knowing up front:

- **Got a question?** Open a [GitHub issue](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/issues) with the `question` label. No need to apologize for asking, we'd rather answer the same question ten times than have you stuck.
- **Found a bug?** Open an issue with a clear repro. Include your AdonisJS version, Node version, and what you expected versus what actually happened.
- **Got a feature idea?** Open an issue first to discuss it before sending a PR. Saves everyone time if the idea doesn't fit the package's scope.
- **Security issue?** Please don't open a public issue. Email the maintainer directly first "ismaelhaytamtanane@gmail.com".

---

## Setting up your environment

You'll need:

- Node.js 24 or above
- PostgreSQL (for integration tests)
- Redis (for integration tests)

Clone the repo and install dependencies:

```bash
git clone https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy.git
cd Adonisjs-lasagna-saas-tenancy
npm install
```

That's it. You're ready to start hacking.

---

## Running the tests

There are two test suites:

```bash
# Unit tests: fast, no external services needed
npm test

# Integration tests: need PostgreSQL and Redis running
npm run test:integration
```

The integration tests automatically rebuild the package first (`tsc → build/`), so you don't need to run `npm run build` separately.

For integration tests, the easiest setup is Docker:

```bash
docker run -d --name pg-test -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:15
docker run -d --name redis-test -p 6379:6379 redis:7
```

Then export the env vars (or drop them into a `.env`):

```bash
export DB_HOST=127.0.0.1 DB_PORT=5432 DB_USER=postgres DB_PASSWORD=postgres DB_DATABASE=multitenancy_test
export REDIS_HOST=127.0.0.1 REDIS_PORT=6379
export QUEUE_REDIS_HOST=127.0.0.1 QUEUE_REDIS_PORT=6379 QUEUE_REDIS_DB=1
export CACHE_REDIS_HOST=127.0.0.1 CACHE_REDIS_PORT=6379 CACHE_REDIS_DB=2
export APP_KEY=a-32-character-long-secret-key!! HOST=127.0.0.1 PORT=3333 LOG_LEVEL=error TENANT_HEADER_KEY=x-tenant-id
```

Before pushing, also run:

```bash
npm run typecheck    # confirms TypeScript is happy
npm run build        # confirms the package compiles cleanly
```

CI will run all three, so saving yourself the round-trip helps.

---

## Coding standards

We try to keep things simple:

- **TypeScript everywhere.** This is an npm-workspaces monorepo: the core package lives in `packages/core/` (source in `packages/core/src/`, tests in `packages/core/tests/`) and each satellite in `packages/<name>/`. The reference app is `examples/api/`.
- **Follow the existing style.** ESLint and Prettier are set up. Run `npm run lint` if you want to check, or just let your editor's Prettier plugin handle it on save.
- **Naming.** Files are `snake_case.ts`. Classes are `PascalCase`. Functions and variables are `camelCase`.
- **Add tests for what you change.** Bug fixes deserve a regression test. New features need their own tests covering the happy path and obvious edge cases.
- **Keep it focused.** One PR should do one thing. If you find yourself fixing five unrelated issues, please split them into separate PRs.
- **No comments unless they're needed.** If a line of code needs an explanation, the explanation should describe *why*, not *what*. Good code mostly explains itself.

---

## Submitting a pull request

1. **Fork the repo** and create a branch from `master`. Use a descriptive name like `fix/circuit-breaker-singleton` or `feat/sso-token-refresh`.

2. **Make your changes.** Commit early and often. We'll squash on merge anyway, so don't worry about a perfect commit history.

3. **Run the checks** locally:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```

4. **Open a PR against `master`** with a clear title and description. Tell us:
   - What problem you're solving
   - How you solved it
   - Anything reviewers should pay extra attention to
   - Any breaking changes (please call these out clearly)

5. **Be patient and friendly.** Reviews might take a few days. We'll do our best to be responsive, and we ask the same of you. If feedback comes back, treat it as a conversation, not a verdict.

That's the whole process. Don't overthink it.

---

## Releasing (Changesets)

Releases are automated with [Changesets](https://github.com/changesets/changesets). You never
hand-bump a version or edit a `CHANGELOG.md`.

- **When you change published behaviour** of any package (the core or a satellite), run
  `npx changeset`, pick the affected package(s) and bump level, and commit the generated file
  with your PR. Docs/CI-only changes don't need one.
- **On merge to `master`**, [`release.yml`](.github/workflows/release.yml) either opens a
  "version packages" PR (when changesets are pending) or, when none are pending, runs
  `changeset publish` to ship any package whose version isn't on npm yet. Publishing is
  idempotent and happens in dependency order (core before its satellites).
- **Prereleases:** `npx changeset pre enter next`, land changesets, then
  `npx changeset pre exit` — these publish under the `next` dist-tag.
- [`publish.yml`](.github/workflows/publish.yml) is a manual break-glass fallback
  (`workflow_dispatch`) for recovering a partial publish; don't use it for normal releases.

---

## A note on scope

This package focuses on schema-based multi-tenancy for AdonisJS with PostgreSQL. We're cautious about adding features that drift from that scope (for example, supporting other databases, building general SaaS billing tools, or auth flows beyond SSO). If you're not sure whether your idea fits, open an issue first and we can talk it through.

---

## Recognition

Every contributor gets credit in the commit history and release notes. If you've made a meaningful contribution, we'd love to add you to a contributors list in the README, just let us know if you'd like to be included.

Thanks again for being here.
