# Security policy

The full, maintained security policy (the per-feature guarantee table, the
threat model, the host responsibilities, and the deployment checklist) lives in
the docs: **[Security guide](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/security)**
([source](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/security.md)).
This file is the short version so GitHub surfaces a Security policy.

## Supported versions

Security fixes target the latest published **1.x** minor. Pin a version and
upgrade to receive them.

## Reporting a vulnerability

Please **do not** open a public issue for security reports. Instead, use one of
the private channels:

- Open a private security advisory at
  [github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/security/advisories/new](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/security/advisories/new), or
- Email the maintainer directly (see [`package.json`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/package.json) for the current contact).

Include a minimal reproduction (PostgreSQL + Redis are fine), the package
version, and the threat model you are testing against. We will acknowledge
within **72 hours** and coordinate a fix and disclosure window.

## Stability and scope

The isolation core is a release candidate and the satellites are experimental.
Reports against the core isolation guarantees (cross-tenant read or write
leakage, resolver hijack, fail-open under dependency outage) are highest
priority. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/docs/stability)
for the per-feature labels.
