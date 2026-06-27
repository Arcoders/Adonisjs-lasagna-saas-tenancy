#!/usr/bin/env node
/**
 * Backoffice isolation guard.
 *
 * The `backoffice` schema is shared across all tenants: its satellite tables
 * (audit logs, feature flags, webhooks, branding, metrics, plans) hold every
 * tenant's rows side by side, keyed by `tenant_id`. A `BackofficeBaseModel`
 * query that forgets the `tenant_id` filter silently reads or writes across
 * tenants — a cross-tenant leak with no schema boundary to catch it.
 *
 * This guard fails CI when a backoffice-model `.query()` is neither scoped by
 * `tenant_id`/`tenantId` in the same statement nor explicitly tagged
 * `// backoffice-scope-exempt: <reason>`. The genuine cross-tenant sweeps (the
 * webhook retry drain, the audit export) carry that marker, so a NEW unscoped
 * query is the only thing that trips it. The Japa architectural spec
 * `backoffice_models_tenant_scoped.spec.ts` enforces the same rule at unit time;
 * this script is the standalone CI/`npm run check` entry point.
 *
 * Run: `node scripts/check-backoffice-isolation.mjs` (`--self-test` exercises the
 * detector against known-good/known-bad fixtures).
 */
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const BACKOFFICE_MODELS = [
  'TenantAuditLog',
  'TenantBranding',
  'TenantCustomMetric',
  'TenantFeatureFlag',
  'TenantMetric',
  'TenantMetricMonthly',
  'TenantPlan',
  'TenantWebhook',
  'TenantWebhookDelivery',
]

const QUERY_RE = new RegExp(`\\b(${BACKOFFICE_MODELS.join('|')})\\.query\\(`)
const SCOPE_RE = /tenant_?id/i
const EXEMPT_RE = /backoffice-scope-exempt/

/** Returns the violations found in one file's text. */
function scan(text) {
  const lines = text.split('\n')
  const violations = []
  for (let i = 0; i < lines.length; i++) {
    const m = QUERY_RE.exec(lines[i])
    if (!m) continue
    const end = Math.min(lines.length, i + 6)
    const stmt = lines.slice(i, end).join('\n')
    const marker = lines.slice(Math.max(0, i - 1), end).join('\n')
    if (SCOPE_RE.test(stmt) || EXEMPT_RE.test(marker)) continue
    violations.push({ line: i + 1, model: m[1] })
  }
  return violations
}

if (process.argv.includes('--self-test')) {
  const bad = 'const x = TenantWebhook.query()\n  .where(\'id\', id)\n  .first()'
  const goodScoped = 'TenantWebhook.query()\n  .where(\'tenant_id\', tenantId)'
  const goodExempt = '// backoffice-scope-exempt: sweep\nTenantWebhook.query()'
  const checks = [
    ['known-bad is flagged', scan(bad).length === 1],
    ['scoped query passes', scan(goodScoped).length === 0],
    ['exempt query passes', scan(goodExempt).length === 0],
  ]
  let ok = true
  for (const [name, pass] of checks) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`)
    if (!pass) ok = false
  }
  process.exit(ok ? 0 : 1)
}

// Scan tracked TS source under every package (backoffice models are core, but a
// satellite could import and misuse them). `git ls-files` respects .gitignore.
const tracked = execSync('git ls-files -z -- "packages/**/src/**/*.ts"', {
  cwd: ROOT,
  maxBuffer: 64 * 1024 * 1024,
})
  .toString('utf8')
  .split('\0')
  .filter(Boolean)

const failures = []
let scanned = 0
for (const rel of tracked) {
  // The model definitions themselves are not query sites.
  if (rel.includes('/models/satellites/')) continue
  const violations = scan(readFileSync(join(ROOT, rel), 'utf8'))
  scanned++
  for (const v of violations) {
    failures.push(`${rel}:${v.line}  ${v.model}.query() is not tenant-scoped or exempt`)
  }
}

console.log(`check-backoffice-isolation: scanned ${scanned} files`)
if (failures.length > 0) {
  console.error(
    `\ncheck-backoffice-isolation: FAIL — ${failures.length} unscoped backoffice query(ies):\n`
  )
  for (const f of failures) console.error('  - ' + f)
  console.error(
    '\nEvery backoffice-model query must filter by tenant_id/tenantId, or carry a' +
      '\n`// backoffice-scope-exempt: <reason>` marker for a deliberate cross-tenant sweep.' +
      '\nRun locally: node scripts/check-backoffice-isolation.mjs'
  )
  process.exit(1)
}
console.log('check-backoffice-isolation: passed — all backoffice queries are tenant-scoped or exempt.')
