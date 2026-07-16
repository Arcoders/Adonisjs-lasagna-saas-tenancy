# create-lasagna-saas

Scaffold an AdonisJS 7 app with Lasagna multitenancy already wired.

> **Not published, and it cannot run yet.** This package lives in the monorepo so the
> golden install path is compiled and tested alongside the package it installs. Neither
> `create-lasagna-saas` nor `@adonisjs-lasagna/saas-tenancy` resolves on npm today, so
> step 2 below fails by design rather than scaffolding a half-wired app. Until the first
> publish, follow [the quickstart](../../docs/start/quickstart.md).

## What it does

It runs the one install sequence this repository proves works on a clean machine, the
same sequence [`scripts/clean-install-smoke.sh`](../../scripts/clean-install-smoke.sh)
drives against a packed tarball in CI:

1. `npm init adonisjs@latest -- <dir> --kit=api --pkg=npm --skip-migrations`
2. installs `pg`, `@adonisjs/redis`, `@adonisjs/queue` and `@adonisjs-lasagna/saas-tenancy@>=0.3.0`
3. `node ace configure` for redis, then queue, then the package
4. writes `config/database.ts` and appends the multitenancy keys to `.env`

The floor in step 2 is load bearing. Before 0.3.0 the package's root entry never
re-exported its `configure` hook, so `node ace configure` warned once, exited 0, and
published nothing. Unpinned, npm could resolve such a version and leave you with an app
that only fails later, at `tenant:create`, on a missing relation.

Step 4 is the reason it exists. `configure` publishes the tenant model, the repository,
the provider and the migrations, but `config/database.ts` belongs to Lucid, so it never
touches it. Two details there are load bearing, and both have broken installs before:
`searchPath` must sit beside `connection` rather than nested inside it, and a `tenant`
template connection must exist for the schema driver to clone. Everything else the
scaffolder does, a reader could copy out of the quickstart.

It never touches your database. Creating one, running `backoffice:setup` and draining the
provisioning job are printed as next steps, not performed.

## Usage

```sh
create-lasagna-saas my-saas
create-lasagna-saas my-saas --with=webhooks,maintenance
create-lasagna-saas my-saas --dry-run
```

`--with` is forwarded verbatim to `configure --with=`. This package validates its shape
and leaves membership to `configure`, so a new core bundle needs no change here.

`--dry-run` prints the ordered plan and writes nothing. It is the fastest way to see what
the scaffolder would do, and it needs no network.

## Layout

`src/` is pure. `parseOptions` maps argv to options, `planActions` maps options to an
ordered list of actions, and `templates.ts` renders the files. `src/run.ts` is the only
module that spawns a process or writes to disk, which is why the whole surface is
unit-tested without a network, a database, or a scaffolded app.

Arguments reach `create-adonisjs` as argv with no shell in between, so there is no
command injection to defend against. The directory name is still validated: a leading
dash would be read as a flag rather than a destination, and a traversal would scaffold
the app outside the current directory.
