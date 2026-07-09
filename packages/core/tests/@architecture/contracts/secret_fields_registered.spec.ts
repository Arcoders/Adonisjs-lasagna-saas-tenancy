import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registeredSecretLeafNames } from '../../../src/providers/secret_config_fields.js'

/**
 * WS-2: you cannot add a secret-shaped config field without a conscious strength
 * decision. Every property in the multitenancy config type whose name matches
 * /secret|key|token|password/i must either be covered by `SECRET_CONFIG_FIELDS`
 * (enforced with a length floor, or explicitly exempt) or appear in the
 * co-located non-secret allowlist below (a field whose NAME merely contains
 * "key"/"token" but holds an identifier, not a secret).
 *
 * Matched by leaf name: the registry validates by full path, but several secret
 * fields share the leaf `password`, so coverage is checked at the leaf level.
 */

const CONFIG_TS = fileURLToPath(new URL('../../../src/types/config.ts', import.meta.url))

const SECRET_NAME = /secret|key|token|password/i

// Config fields whose NAME looks secret-shaped but hold a non-secret value (a
// request field name, a header name, a cache-key prefix). One entry per name
// with the reason it is not a secret.
const NON_SECRET_ALLOWLIST: ReadonlyArray<{ name: string; why: string }> = [
  { name: 'queryKey', why: 'name of the query-string field carrying the tenant id' },
  { name: 'bodyKey', why: 'name of the request-body field carrying the tenant id' },
  { name: 'tenantHeaderKey', why: 'name of the HTTP header carrying the tenant id' },
  { name: 'wizardKeyPrefix', why: 'cache-key prefix string, not a credential' },
]
const ALLOWED = new Set(NON_SECRET_ALLOWLIST.map((e) => e.name))

// A property declaration line: `name: T` or `name?: T`, not a comment.
const PROP_DECL = /^\s*([a-zA-Z_]\w*)\s*\??\s*:/

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

test.group('contract — every secret-shaped config field is registered', () => {
  test('no secret-named config field is missing from SECRET_CONFIG_FIELDS or the allowlist', ({
    assert,
  }) => {
    const registered = registeredSecretLeafNames()
    const src = readFileSync(CONFIG_TS, 'utf8')
    const violations: string[] = []

    for (const line of src.split('\n')) {
      if (isComment(line)) continue
      const m = PROP_DECL.exec(line)
      if (!m) continue
      const name = m[1]!
      if (!SECRET_NAME.test(name)) continue
      if (registered.has(name) || ALLOWED.has(name)) continue
      violations.push(name)
    }

    assert.deepEqual(
      violations,
      [],
      [
        'Found secret-shaped config field(s) with no strength decision:',
        ...violations.map((v) => `  - ${v}`),
        '',
        'Add the field to SECRET_CONFIG_FIELDS (with a minLength + enforce: true, or',
        'enforce: false + reason for an operator-managed credential), or, if the name',
        'merely looks secret-shaped but holds an identifier, add it to NON_SECRET_ALLOWLIST.',
      ].join('\n')
    )
  })

  test('the enforced fields carry a positive minLength', ({ assert }) => {
    // Guards against an enforced row with no floor (a silently no-op check).
    const leaves = registeredSecretLeafNames()
    assert.isTrue(leaves.has('secret'), 'impersonation.secret leaf is registered')
    assert.isTrue(leaves.has('bypassToken'), 'maintenance.bypassToken leaf is registered')
    assert.isTrue(leaves.has('password'), 'infra password leaf is registered (exempt)')
  })

  test('detector control: a secret-shaped name not covered would be flagged', ({ assert }) => {
    const registered = registeredSecretLeafNames()
    assert.isFalse(
      registered.has('apiSecret'),
      'a hypothetical new apiSecret is not yet registered'
    )
    assert.isTrue(SECRET_NAME.test('apiSecret'))
  })
})
