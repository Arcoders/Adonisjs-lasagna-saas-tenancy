#!/usr/bin/env node
// Guards the extension-surface standard: every surface that hosts third-party
// extensions must declare a CONTRACT_VERSION (a positive integer), document it
// in the extensibility standard page, and the demo must declare contractVersion
// on the extensions it registers. Mirrors the structure of
// check-satellite-graduation.mjs (a pure, dependency-free CI gate).
//
// Driven by the SURFACES table below because three surfaces (audit,
// feature-flags, webhooks) live inside packages/core, not in a satellite of
// their own — the "one surface per package" assumption does not hold.

import { readFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { stripJsComments } from './lib/strip-js-comments.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

/**
 * Each extension surface: the constant that versions it (`constant`) and the file the
 * constant lives in (`file`). A surface that has reached a breaking version (> 1) must
 * additionally declare `shapeGate` — the registry file whose `assertShape` override
 * enforces the newly-required member (EXT-3), or `null` when the surface is a config
 * hook with no registration seam. Below v2 `shapeGate` is optional.
 */
const SURFACES = [
  {
    key: 'reporting',
    constant: 'REPORTING_CONTRACT_VERSION',
    file: 'packages/reporting/src/constants.ts',
  },
  {
    key: 'billing',
    constant: 'BILLING_CONTRACT_VERSION',
    file: 'packages/billing/src/constants.ts',
  },
  {
    key: 'websockets',
    constant: 'WEBSOCKETS_CONTRACT_VERSION',
    file: 'packages/websockets/src/constants.ts',
  },
  { key: 'admin', constant: 'ADMIN_CONTRACT_VERSION', file: 'packages/admin/src/constants.ts' },
  { key: 'sso', constant: 'SSO_CONTRACT_VERSION', file: 'packages/sso/src/constants.ts' },
  {
    key: 'audit',
    constant: 'AUDIT_CONTRACT_VERSION',
    file: 'packages/core/src/services/audit_log_destination_registry.ts',
  },
  {
    key: 'feature-flags',
    constant: 'FEATURE_FLAGS_CONTRACT_VERSION',
    file: 'packages/core/src/services/evaluation_strategy_registry.ts',
  },
  {
    key: 'webhooks',
    constant: 'WEBHOOKS_CONTRACT_VERSION',
    file: 'packages/core/src/services/webhook_transformer_registry.ts',
  },
  {
    key: 'isolation',
    constant: 'ISOLATION_CONTRACT_VERSION',
    file: 'packages/core/src/services/isolation/driver.ts',
    shapeGate: 'packages/core/src/services/isolation/registry.ts',
  },
  {
    key: 'resolver',
    constant: 'RESOLVER_CONTRACT_VERSION',
    file: 'packages/core/src/services/resolvers/resolver.ts',
    shapeGate: 'packages/core/src/services/resolvers/registry.ts',
  },
  // Plugin-platform request-path seams (Lote A): each hosts host/third-party code
  // and versions independently of satelliteApi and the definePlugin facade.
  {
    key: 'authorizer',
    constant: 'AUTHORIZER_CONTRACT_VERSION',
    file: 'packages/core/src/services/authorizer_registry.ts',
  },
  {
    key: 'tenant-middleware',
    constant: 'TENANT_MIDDLEWARE_CONTRACT_VERSION',
    file: 'packages/core/src/services/tenant_middleware_registry.ts',
  },
  {
    key: 'capability',
    constant: 'CAPABILITY_CONTRACT_VERSION',
    file: 'packages/core/src/services/capability_registry.ts',
  },
  { key: 'ai', constant: 'AI_CONTRACT_VERSION', file: 'packages/ai/src/sdk/contract_version.ts' },
  {
    key: 'crypto',
    constant: 'CRYPTO_CONTRACT_VERSION',
    file: 'packages/crypto/src/sdk/contract_version.ts',
  },
]

/**
 * `*_CONTRACT_VERSION` constants that are NOT per-surface extension registries and so
 * are exempt from the "every contract version is a documented surface" meta-check.
 * PLUGIN_API_CONTRACT_VERSION versions the definePlugin FACADE (guarded by
 * check-abi-boot-assertion's pluginApiVersion mirror), not an extension registry.
 */
const NON_SURFACE_CONTRACT_VERSIONS = new Set(['PLUGIN_API_CONTRACT_VERSION'])

const DOCS = 'docs/guides/extensibility.md'
const EXAMPLE = 'examples/api/app/providers/app_provider.ts'

const errors = []
const versions = new Map()

for (const s of SURFACES) {
  if (!existsSync(r(s.file))) {
    errors.push(`${s.key}: missing ${s.file}`)
    continue
  }
  const src = readFileSync(r(s.file), 'utf8')
  const match = src.match(new RegExp(`export const ${s.constant}\\s*=\\s*(\\d+)`))
  if (!match) {
    errors.push(`${s.key}: ${s.file} does not \`export const ${s.constant} = <n>\``)
    continue
  }
  const value = Number.parseInt(match[1], 10)
  if (!(value > 0)) {
    errors.push(`${s.key}: ${s.constant} must be a positive integer (got ${match[1]})`)
  }
  versions.set(s.constant, value)
}

// EXT-3: a contract version > 1 is a BREAKING bump, but `assertContractCompat` only
// WARNS a plugin built against an older version — so a plugin missing the newly required
// member boots (with a warning) and then crashes mid-request. A surface above 1 must back
// the bump with a boot-time SHAPE gate: an `assertShape` override in its `ExtensionRegistry`
// subclass that throws when the member is absent, converting warn-then-crash into a
// register-time failure. So every surface that reaches v>1 MUST declare `shapeGate` — the
// registry file whose assertShape override enforces the member, or `null` for a non-registry
// surface (a config hook like the websockets `authorize`, which has no registration seam to
// gate). An UNDECLARED shapeGate at v>1 is itself an error, so a future bump (core OR
// satellite) cannot silently escape the requirement. Satellites stay on 1 today, so none
// trip this yet — but the first one to bump must declare its shapeGate.
for (const s of SURFACES) {
  const version = versions.get(s.constant)
  if (version === undefined || version <= 1) continue
  if (!('shapeGate' in s)) {
    errors.push(
      `${s.key}: ${s.constant} is ${version} (a breaking bump) but declares no shapeGate. A ` +
        `breaking bump only WARNS older plugins via assertContractCompat, so a missing required ` +
        `member would warn-then-crash. Declare shapeGate: the registry file whose assertShape() ` +
        `override throws when the member is absent (EXT-2), or shapeGate: null for a non-registry ` +
        `surface (a config hook with no registration seam).`
    )
    continue
  }
  if (s.shapeGate === null) continue // a documented non-registry surface (config hook)
  if (!existsSync(r(s.shapeGate))) {
    errors.push(`${s.key}: shapeGate file ${s.shapeGate} not found`)
    continue
  }
  // Strip comments first: a doc-comment MENTIONING assertShape must not satisfy the gate.
  if (!/\bassertShape\s*\(/.test(stripJsComments(readFileSync(r(s.shapeGate), 'utf8')))) {
    errors.push(
      `${s.key}: ${s.constant} is ${version} but its shapeGate ${s.shapeGate} has no assertShape() ` +
        `override. Add one that throws when the newly required member is absent (EXT-2).`
    )
  }
}

// Meta-check: every `export const *_CONTRACT_VERSION` under a package's src MUST be a
// registered surface (or an allowlisted non-surface), so a NEW extension surface can't
// ship unguarded/undocumented — the exact gap that left AI + crypto out of this table.
const known = new Set([...SURFACES.map((s) => s.constant), ...NON_SURFACE_CONTRACT_VERSIONS])
const tracked = execSync('git ls-files -z -- "packages/**/src/**/*.ts"', {
  cwd: ROOT,
  maxBuffer: 64 * 1024 * 1024,
})
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
for (const rel of tracked) {
  const src = readFileSync(r(rel), 'utf8')
  for (const m of src.matchAll(/export const (\w+_CONTRACT_VERSION)\s*=/g)) {
    if (!known.has(m[1])) {
      errors.push(
        `${rel}: exports ${m[1]} but it is not a registered extension surface. Add it to ` +
          `SURFACES (and document it in ${'docs/guides/extensibility.md'}), or to ` +
          `NON_SURFACE_CONTRACT_VERSIONS if it is not an extension registry.`
      )
    }
  }
}

// The standard page must document every surface's contract-version constant, so
// a new surface can't ship without a line in the standard.
if (!existsSync(r(DOCS))) {
  errors.push(`missing the extensibility standard page ${DOCS}`)
} else {
  const docs = readFileSync(r(DOCS), 'utf8')
  for (const s of SURFACES) {
    if (!docs.includes(s.constant)) {
      errors.push(`${DOCS} does not document ${s.constant} (${s.key})`)
    }
  }
}

// The demo must lead by example: any file that registers extensions should
// declare contractVersion on them.
if (existsSync(r(EXAMPLE)) && !readFileSync(r(EXAMPLE), 'utf8').includes('contractVersion')) {
  errors.push(`${EXAMPLE}: the demo extensions must declare \`contractVersion\``)
}

if (errors.length > 0) {
  console.error('check-extension-contracts: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-extension-contracts: OK (${SURFACES.length} surfaces verified)`)
