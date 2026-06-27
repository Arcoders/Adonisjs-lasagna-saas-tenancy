## What & why

<!-- What problem does this solve? How did you solve it? Anything reviewers should look at closely? -->

## Checklist

- [ ] Tests added/updated for the change (unit and/or integration).
- [ ] All CI gates pass locally: `npm run lint`, `npm run typecheck`, `npm test`,
      `npm run check`, and `npm run knip:deps` (if a `package.json` dep/peer changed).
      See [CONTRIBUTING.md](../CONTRIBUTING.md#checks-ci-will-run).
- [ ] Added a changeset (`npx changeset`) if this changes published behaviour of any
      package (`@adonisjs-lasagna/saas-tenancy` or a satellite). Skip for docs/CI-only changes.
- [ ] Docs touched? Followed [docs/STYLE.md](../docs/STYLE.md); `npm run docs:build` (dead-link
      gate) and `npm run test:integrity` pass. Moved a page? Added a `docs/redirects.json` entry.
- [ ] Breaking changes are called out explicitly above.
