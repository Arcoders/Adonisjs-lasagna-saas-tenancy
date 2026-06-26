import { test } from '@japa/runner'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Architectural guard for the admin audit trail. It reads the controller source
 * (no Ignitor) and proves three invariants that the rest of the suite assumes:
 *
 *   1. Completeness — every controller method that performs a mutation also
 *      records an audit row (or carries an explicit `// audit-exempt:` marker).
 *      A new endpoint that mutates without auditing fails this test.
 *   2. Action names — each documented `admin:<resource>:<verb>` action literal is
 *      present in its controller, so a rename/drop is caught.
 *   3. No secret leak — no `auditAdminAction(...)` call passes a secret in its
 *      metadata. This turns the "ids and flags only, never secrets" rule into a
 *      test rather than a convention.
 *
 * Modeled on packages/core/tests/architectural/no_unsafe_raw_sql.spec.ts.
 */

const SRC = fileURLToPath(new URL('../../src/', import.meta.url))
const CONTROLLERS_DIR = `${SRC}controllers/`

/** Read every `*_controller.ts` under src/, plus the top-level admin_controller. */
function controllerSources(): { name: string; src: string }[] {
  const files = readdirSync(CONTROLLERS_DIR)
    .filter((f) => f.endsWith('_controller.ts'))
    .map((f) => ({ name: f, src: readFileSync(`${CONTROLLERS_DIR}${f}`, 'utf8') }))
  files.push({
    name: 'admin_controller.ts',
    src: readFileSync(`${SRC}admin_controller.ts`, 'utf8'),
  })
  return files
}

/**
 * Mutation primitives. A method body containing any of these writes persistent
 * state and therefore must audit. Impersonation (`svc.start`/`svc.stop`) is
 * deliberately absent: ImpersonationService audits those itself.
 */
const MUTATION =
  /\.save\(\)|registerWebhook\(|svc\.set\(|svc\.delete\(|svc\.upsert\(|svc\.setUsage\(|svc\.reset\(|deleteWebhook\(|svc\.send\(|repo\.create\(|\.activate\(\)|\.suspend\(\)|enterMaintenance\(|exitMaintenance\(|driver\.destroy\(|upsertConfig\(/

/** Split a controller file into method-sized chunks (`  async name(...) {`). */
function methodChunks(src: string): string[] {
  return src.split(/\n {2}async /)
}

/** Extract the full argument text of every `auditAdminAction(...)` via paren balancing. */
function auditCallArgs(src: string): string[] {
  const out: string[] = []
  const re = /auditAdminAction\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length
    let depth = 1
    const start = i
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === '(') depth++
      else if (c === ')') depth--
      i++
    }
    out.push(src.slice(start, i - 1))
  }
  return out
}

/** Number of `auditAdminAction(` call sites in a source string. */
function auditCount(src: string): number {
  return (src.match(/auditAdminAction\(/g) ?? []).length
}

// Every audited action, grouped by the controller it must live in.
const EXPECTED_ACTIONS: Record<string, string[]> = {
  'webhooks_controller.ts': [
    'admin:webhook:create',
    'admin:webhook:update',
    'admin:webhook:delete',
    'admin:webhook:retry',
  ],
  'feature_flags_controller.ts': [
    'admin:feature_flag:create',
    'admin:feature_flag:update',
    'admin:feature_flag:delete',
  ],
  'branding_controller.ts': ['admin:branding:update'],
  'sso_controller.ts': ['admin:sso:update', 'admin:sso:disable'],
  'quotas_controller.ts': ['admin:quota:set_usage', 'admin:quota:reset'],
  'admin_actions_controller.ts': ['admin:action:dispatch'],
  'admin_controller.ts': [
    'admin:tenant:create',
    'admin:tenant:activate',
    'admin:tenant:suspend',
    'admin:tenant:destroy',
    'admin:tenant:restore',
    'admin:tenant:maintenance_enter',
    'admin:tenant:maintenance_exit',
  ],
}

// The sum of EXPECTED_ACTIONS — the total number of audit call sites we expect.
const EXPECTED_TOTAL = Object.values(EXPECTED_ACTIONS).reduce((n, a) => n + a.length, 0)

// Never allowed inside an audit call's metadata. `\bsecret\b` flags a bare
// `secret` key/value but not the compound `secretGenerated` / `generatedSecret`
// flags (no word boundary), which are safe booleans.
const FORBIDDEN_IN_METADATA =
  /\b(secret|clientSecret|client_secret|password|passwd|apiKey|api_key)\b/i

test.group('admin audit coverage (source scan)', () => {
  test('every mutating controller method audits (or is explicitly exempt)', ({ assert }) => {
    const violations: string[] = []
    for (const { name, src } of controllerSources()) {
      for (const chunk of methodChunks(src)) {
        if (!MUTATION.test(chunk)) continue
        const audited = chunk.includes('auditAdminAction(') || /\/\/\s*audit-exempt:/.test(chunk)
        if (!audited) {
          const method = chunk.match(/^(\w+)\(/)?.[1] ?? '(unknown)'
          violations.push(
            `${name}: ${method} mutates without auditAdminAction or an audit-exempt marker`
          )
        }
      }
    }
    assert.deepEqual(violations, [], `unaudited mutations:\n${violations.join('\n')}`)
  })

  test('each documented action name is present in its controller', ({ assert }) => {
    const missing: string[] = []
    for (const [file, actions] of Object.entries(EXPECTED_ACTIONS)) {
      const src = readFileSync(
        file === 'admin_controller.ts' ? `${SRC}${file}` : `${CONTROLLERS_DIR}${file}`,
        'utf8'
      )
      for (const action of actions) {
        if (!src.includes(`'${action}'`)) missing.push(`${file}: ${action}`)
      }
    }
    assert.deepEqual(missing, [], `missing action literals:\n${missing.join('\n')}`)
  })

  test('the number of audit call sites matches the expected total', ({ assert }) => {
    const total = controllerSources().reduce((n, { src }) => n + auditCount(src), 0)
    assert.equal(
      total,
      EXPECTED_TOTAL,
      `expected ${EXPECTED_TOTAL} auditAdminAction call sites, found ${total}. ` +
        'If you added or removed an audited action, update EXPECTED_ACTIONS.'
    )
  })

  test('no audit metadata ever references a secret', ({ assert }) => {
    const leaks: string[] = []
    for (const { name, src } of controllerSources()) {
      for (const args of auditCallArgs(src)) {
        if (FORBIDDEN_IN_METADATA.test(args)) {
          leaks.push(
            `${name}: auditAdminAction call references a secret in metadata -> ${args.replace(/\s+/g, ' ').trim()}`
          )
        }
      }
    }
    assert.deepEqual(leaks, [], `secret leak in audit metadata:\n${leaks.join('\n')}`)
  })
})
