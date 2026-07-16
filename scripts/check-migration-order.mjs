#!/usr/bin/env node
// Guard against a migration that runs before the table it needs exists.
//
// `migration:run` sorts by filename, and every migration stub names its own output
// `${Date.now()}_<name>.ts`. So the emitted filename records WHEN a stub rendered,
// never the order the publisher asked for. Two stubs of one batch render in the
// same millisecond, tie, and Lucid breaks the tie alphabetically:
//
//   tenant_webhook_deliveries  <  tenant_webhooks     (the FK target runs second)
//   add_processing_status_…    <  create_…_table      (the ALTER runs first)
//
// Both shipped. `finalizeNewMigrations` fixes the mechanism — the publisher now
// re-stamps a batch so publish order IS run order. This guard fixes the policy: it
// checks that the publish order a package DECLARES is actually a valid dependency
// order, because the mechanism will faithfully seal in whatever order it is handed.
//
// Publish order is:
//   core        — the arrays in `SATELLITE_BUNDLES` / `OPT_IN_BUNDLES` (configure.ts),
//                 each preceded by `create_tenants_table` (published unconditionally,
//                 with a fixed zero timestamp, before any bundle).
//   satellites  — `readdir().sort()` over the stub dir, which is why a satellite whose
//                 migrations depend on each other numbers them `NNNN_`.
//
// Usage: node scripts/check-migration-order.mjs [--self-test]

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Core publishes this one before every bundle, stamped `0000000000000`. */
const ALWAYS_FIRST = 'create_tenants_table'

/** `backoffice.billing_customers` -> `billing_customers`. */
function bareTable(name) {
  const parts = name.split('.')
  return parts[parts.length - 1]
}

/**
 * The tables a stub creates and the tables it needs to already exist. Reads both
 * the Lucid schema builder (`createTable` / `alterTable` / `inTable`) and the raw
 * SQL a stub drops to when it swaps a CHECK constraint or an index.
 *
 * A table the stub creates is never also a dependency of it, so `references`
 * excludes `creates`.
 */
export function analyzeStub(body) {
  const declared = body.match(/protected\s+tableName\s*=\s*['"]([\w.]+)['"]/)
  const tableName = declared ? bareTable(declared[1]) : null

  const creates = new Set()
  const references = new Set()

  const builder = (method, sink) => {
    const re = new RegExp(`\\.${method}\\(\\s*(?:this\\.tableName|['"]([\\w.]+)['"])`, 'g')
    for (const m of body.matchAll(re)) {
      const table = m[1] ? bareTable(m[1]) : tableName
      if (table) sink.add(table)
    }
  }
  builder('createTable', creates)
  builder('alterTable', references)

  for (const m of body.matchAll(/\.inTable\(\s*['"]([\w.]+)['"]/g)) {
    references.add(bareTable(m[1]))
  }
  // `ALTER TABLE "backoffice"."x"` and `ALTER TABLE backoffice.x` alike. A stub that
  // interpolates the table name (`ALTER TABLE ${t}`) simply does not match, and an
  // unresolvable dependency is one we cannot check either way.
  const rawAlter = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"?\w+"?\s*\.\s*)?"?(\w+)"?/gi
  for (const m of body.matchAll(rawAlter)) references.add(m[1])

  return {
    creates: [...creates],
    references: [...references].filter((table) => !creates.has(table)),
  }
}

/**
 * Extract a `Record<string, string[]>` literal from configure.ts source. Returns the
 * bundle name -> ordered stub names. Deliberately narrow: it reads the arrays core's
 * publisher iterates, and nothing else in that file.
 *
 * Comments are stripped first. The prose inside `SATELLITE_BUNDLES` quotes real code
 * (`requires: ["quotas"]`), which reads as a bundle named `requires` otherwise.
 */
export function parseBundles(source, constName) {
  const start = source.indexOf(`export const ${constName}`)
  if (start === -1) return null
  const open = source.indexOf('{', start)
  const end = source.indexOf('\n}', open)
  if (open === -1 || end === -1) return null

  const block = source
    .slice(open, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')

  const bundles = {}
  for (const m of block.matchAll(/['"]?([\w-]+)['"]?\s*:\s*\[([^\]]*)\]/g)) {
    const stubs = [...m[2].matchAll(/['"]([\w-]+)['"]/g)].map((s) => s[1])
    if (stubs.length > 0) bundles[m[1]] = stubs
  }
  return bundles
}

/**
 * Within one publish scope, every table a stub references must be created by a stub
 * that runs earlier. A reference nothing in this scope creates is out of scope (a
 * satellite altering a core table, an RLS stub naming the host's own tables) and is
 * left to the publisher's cross-package ordering.
 */
export function orderProblems(scope, ordered, analyze) {
  const createdAt = new Map()
  ordered.forEach((name, index) => {
    for (const table of analyze(name).creates) {
      if (!createdAt.has(table)) createdAt.set(table, index)
    }
  })

  const problems = []
  ordered.forEach((name, index) => {
    for (const table of analyze(name).references) {
      const creator = createdAt.get(table)
      if (creator === undefined || creator < index) continue
      problems.push(
        `${scope}: "${name}" needs "${table}", but "${ordered[creator]}" creates it later ` +
          `(position ${creator + 1} vs ${index + 1}). Reorder them.`
      )
    }
  })
  return problems
}

/**
 * A satellite's stubs are published in `readdir().sort()` order, so a directory with
 * more than one stub must say what that order is. One unnumbered stub in an otherwise
 * numbered directory silently jumps to the front (digits sort before letters).
 */
export function ordinalProblems(scope, files) {
  if (files.length < 2) return []
  const problems = []
  const seen = new Map()
  for (const file of files) {
    const m = file.match(/^(\d{4})_/)
    if (!m) {
      problems.push(
        `${scope}: "${file}" has no NNNN_ prefix. A directory with 2+ stubs is published in ` +
          `sorted order, so every stub must number itself.`
      )
      continue
    }
    if (seen.has(m[1])) {
      problems.push(`${scope}: "${file}" reuses ordinal ${m[1]} (also "${seen.get(m[1])}")`)
    }
    seen.set(m[1], file)
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const problems = []
  const eq = (actual, expected, label) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
    }
  }

  const createStub = `
    protected tableName = 'billing_processed_events'
    async up() { this.schema.withSchema('backoffice').createTable(this.tableName, () => {}) }
  `
  const alterStub = `
    async up() { this.schema.raw('ALTER TABLE "backoffice"."billing_processed_events" DROP x') }
  `
  const fkStub = `
    protected tableName = 'tenant_webhook_deliveries'
    async up() {
      this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
        table.uuid('webhook_id').references('id').inTable('backoffice.tenant_webhooks')
      })
    }
  `
  const rawUnquoted = `async up() { this.schema.raw('ALTER TABLE backoffice.billing_usage_events ADD x') }`
  const interpolated = 'async up() { this.schema.raw(`ALTER TABLE ${table} ADD x`) }'

  eq(analyzeStub(createStub).creates, ['billing_processed_events'], 'createTable(this.tableName)')
  eq(analyzeStub(createStub).references, [], 'a create is not its own dependency')
  eq(analyzeStub(alterStub).references, ['billing_processed_events'], 'quoted raw ALTER')
  eq(analyzeStub(rawUnquoted).references, ['billing_usage_events'], 'unquoted raw ALTER')
  eq(analyzeStub(interpolated).references, [], 'interpolated table name is unresolvable')
  eq(analyzeStub(fkStub).creates, ['tenant_webhook_deliveries'], 'FK stub creates its table')
  eq(analyzeStub(fkStub).references, ['tenant_webhooks'], 'inTable is a dependency')

  const bodies = { create: createStub, alter: alterStub, unrelated: rawUnquoted }
  const analyze = (name) => analyzeStub(bodies[name])
  eq(orderProblems('t', ['create', 'alter'], analyze).length, 0, 'create before alter passes')
  eq(orderProblems('t', ['alter', 'create'], analyze).length, 1, 'alter before create fails')
  eq(orderProblems('t', ['unrelated'], analyze).length, 0, 'a dependency nobody creates is skipped')

  eq(ordinalProblems('t', ['a.stub']).length, 0, 'a lone stub needs no ordinal')
  eq(ordinalProblems('t', ['0001_a.stub', 'b.stub']).length, 1, 'an unnumbered sibling is flagged')
  eq(ordinalProblems('t', ['0001_a.stub', '0001_b.stub']).length, 1, 'a duplicate ordinal is flagged')
  eq(ordinalProblems('t', ['0001_a.stub', '0002_b.stub']).length, 0, 'a numbered pair passes')

  const bundles = parseBundles(
    `export const B: Record<string, string[]> = {\n` +
      `  a: ['x'],\n` +
      `  // prose quoting real code: requires: ["nope"]\n` +
      `  'b-c': [\n    'y',\n    'z',\n  ],\n}\n`,
    'B'
  )
  eq(bundles, { a: ['x'], 'b-c': ['y', 'z'] }, 'parseBundles reads quoted keys and multiline arrays')

  if (problems.length) {
    console.error('check-migration-order --self-test: FAIL')
    for (const p of problems) console.error(`  - ${p}`)
    process.exit(1)
  }
  console.log('check-migration-order --self-test: OK')
  process.exit(0)
}

if (import.meta.main) {
  const stubs = execFileSync('git', ['ls-files', 'packages/*/stubs/migrations*/*.stub'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)

  const bodyOf = new Map()
  const byDir = new Map()
  for (const rel of stubs) {
    bodyOf.set(rel, readFileSync(join(repoRoot, rel), 'utf8'))
    const dir = dirname(rel).replace(/\\/g, '/')
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir).push(basename(rel))
  }

  const problems = []
  let scopes = 0

  // Satellites: the directory sort is the publish order.
  for (const [dir, files] of byDir) {
    if (dir === 'packages/core/stubs/migrations') continue
    scopes++
    files.sort()
    problems.push(...ordinalProblems(dir, files))
    const analyze = (name) => analyzeStub(bodyOf.get(`${dir}/${name}`))
    problems.push(...orderProblems(dir, files, analyze))
  }

  // Core: each bundle is its own publish batch, always preceded by the tenants table.
  const coreDir = 'packages/core/stubs/migrations'
  const configure = readFileSync(join(repoRoot, 'packages/core/configure.ts'), 'utf8')
  const bundles = {
    ...parseBundles(configure, 'SATELLITE_BUNDLES'),
    ...parseBundles(configure, 'OPT_IN_BUNDLES'),
  }
  if (Object.keys(bundles).length === 0) {
    problems.push('packages/core/configure.ts: could not parse SATELLITE_BUNDLES / OPT_IN_BUNDLES')
  }
  for (const [feature, bundle] of Object.entries(bundles)) {
    scopes++
    const missing = [ALWAYS_FIRST, ...bundle].filter((n) => !bodyOf.has(`${coreDir}/${n}.stub`))
    if (missing.length > 0) {
      problems.push(`core --with=${feature}: names stubs that do not ship: ${missing.join(', ')}`)
      continue
    }
    const analyze = (name) => analyzeStub(bodyOf.get(`${coreDir}/${name}.stub`))
    problems.push(...orderProblems(`core --with=${feature}`, [ALWAYS_FIRST, ...bundle], analyze))
  }

  console.log(`Migration order: checked ${stubs.length} stub(s) across ${scopes} publish scope(s)`)

  if (problems.length > 0) {
    console.error('\ncheck-migration-order: FAIL')
    for (const problem of problems) console.error(`  - ${problem}`)
    console.error(
      '\nA migration must run after the tables it touches exist. Publish order is the' +
        '\nbundle array order (core) or the sorted stub filenames (satellites), and' +
        '\n`finalizeNewMigrations` seals that order into the emitted timestamps.'
    )
    process.exit(1)
  }
  console.log('\ncheck-migration-order: passed — every batch publishes in dependency order')
}
