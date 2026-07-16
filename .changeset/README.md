# Changesets

This folder powers releases for every publishable package in the monorepo
(`@adonisjs-lasagna/saas-tenancy` and the `sso` / `billing` / `admin` / `backup`
satellites). The private demo (`examples/api`) is excluded.

## Adding a changeset

Run this for any change that affects published behaviour:

```bash
npx changeset
```

Pick the affected package(s), choose the bump (patch / minor / major), and write a
one-line summary. That writes a markdown file here; commit it with your PR.

## What happens on merge

`.github/workflows/release.yml` runs on every push to `master`:

- **Pending changesets present** → it opens (or updates) a "version packages" PR
  that bumps versions and rewrites each package's `CHANGELOG.md`. Merging that PR
  publishes the bumped packages to npm.
- **No pending changesets** → it runs `changeset publish`, which publishes any
  package whose `package.json` version isn't on npm yet (idempotent, core first).

Do **not** hand-edit versions or CHANGELOGs, and do **not** run `changeset init`
(it can reset this config / flip `baseBranch` to `main`).

Prereleases: `npx changeset pre enter next`, land changesets, then
`npx changeset pre exit` — prerelease versions publish under the `next` dist-tag.
