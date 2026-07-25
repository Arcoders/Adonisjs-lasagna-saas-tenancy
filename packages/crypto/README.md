# @adonisjs-lasagna/crypto

Field-level encryption for
[`@adonisjs-lasagna/saas-tenancy`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy):
per-`(subject × category)` data keys wrapped under a pluggable KeyProvider (env,
AWS KMS, HashiCorp Vault), a deterministic search HMAC, and O(1) crypto-shredding.
It composes the kernel isolation, secrets and WORM-audit rails instead of laying
parallel track, so a GDPR/CNDP "right to erasure" is a single key destroy rather
than a destructive table scan. It is the keystone of the data-protection satellites.

[![Stability: experimental](https://img.shields.io/badge/stability-experimental-C26A4B)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability)

> **Stability: release candidate.** The config surface, the KeyProvider contract
> and the encryption/shred API are considered final under the 1.x promise, with the
> honest caveat that a correction forced by the pending security review or
> production mileage may land in a 1.x minor with a loud changelog entry. Pin the
> version and read the changelog before upgrading. See the
> [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability).

Under a three-layer key hierarchy (a per-tenant KEK from a pluggable KeyProvider, a
per-`(subject × category)` DEK stored only wrapped, a field sealed under its DEK with
the kernel `enc_v2` envelope), erasing a subject is tombstoning one small key. crypto
is a mechanism, not a policy: it consults governance before a shred and refuses when
governance is absent.

## Install

```bash
npm i @adonisjs-lasagna/crypto @adonisjs-lasagna/saas-tenancy
node ace configure @adonisjs-lasagna/crypto
node ace tenant:migrate   # applies the per-tenant wrapped-DEK table
```

`@adonisjs-lasagna/saas-tenancy` (the core), `@adonisjs/core` and `@adonisjs/redis`
are required peers. `node ace configure` registers the provider in `adonisrc.ts` and
publishes the central rowscope migration stub (run it only under `rowscope-pg`).

## Configure

```ts
// config/multitenancy.ts
import { defineCryptoConfig } from '@adonisjs-lasagna/crypto'

export default defineConfig({
  // ...core config...
  crypto: defineCryptoConfig({
    keyProvider: 'env', // dev-grade; bind aws-kms / hashicorp-vault in production
    fields: {
      'renter.passportNumber': { category: 'identity', searchable: true },
    },
  }),
})
```

The `crypto` block is validated at boot (`assertCryptoConfig`), so a bad shape fails
at startup rather than at the first encrypted write.

## Documentation

See the [Crypto satellite guide](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/crypto)
for the full key hierarchy, the two encryption surfaces (model decorators and
`EncryptedRepository`), blind-index search, the ciphertext CHECK, crypto-shredding,
KEK rotation, and binding a custom KeyProvider.
