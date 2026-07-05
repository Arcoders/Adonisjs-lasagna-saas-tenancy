import { test } from '@japa/runner'
// The T13 (KeyProvider SSRF) guard is a repo-root script (it runs in `npm run check`);
// import its pure auditor to exercise the rule that every KeyProvider outbound routes
// through core safeFetch, and that a second, unpinned egress path is forbidden.
import { auditKeyProviderSsrf } from '../../../../../scripts/check-crypto-invariant-11.mjs'

const BASE = 'packages/crypto/src/services/http_key_provider.ts'
const OTHER = 'packages/crypto/src/services/vault_key_provider.ts'

/** A well-formed egress base (imports + routes through safeFetch), so the presence floor is satisfied. */
const goodBase = {
  path: BASE,
  source: [
    `import { safeFetch } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'`,
    `export default abstract class HttpKeyProvider {`,
    `  protected async request(req) { return safeFetch(req.url, {}) }`,
    `}`,
  ].join('\n'),
}

test.group('architectural — I-T13 KeyProvider SSRF (check-crypto-invariant-11)', () => {
  test('a base routing through safeFetch + a provider using it is clean', ({ assert }) => {
    const vault = {
      path: OTHER,
      source: `export default class VaultKeyProvider extends HttpKeyProvider {\n  async wrapDek(t, d) { return this.requestJson({ url: this.addr }) }\n}`,
    }
    assert.deepEqual(auditKeyProviderSsrf([goodBase, vault]), [])
  })

  test('a bare fetch() outside the base is a violation', ({ assert }) => {
    const bad = { path: OTHER, source: `const r = await fetch('https://kms.internal')` }
    const problems = auditKeyProviderSsrf([goodBase, bad])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /raw network egress/)
  })

  test('globalThis.fetch, http.request, new Request, and raw HTTP-client imports are violations', ({
    assert,
  }) => {
    const cases = [
      `await globalThis.fetch(url)`,
      `import https from 'node:https'; https.request(url)`,
      `const req = new Request(url)`,
      `import axios from 'axios'`,
      `import { request } from 'undici'`,
    ]
    for (const source of cases) {
      const problems = auditKeyProviderSsrf([goodBase, { path: OTHER, source }])
      assert.isAbove(problems.length, 0, `should flag: ${source}`)
    }
  })

  test('safeFetch in the base is NOT self-flagged, and a comment mentioning fetch is ignored', ({
    assert,
  }) => {
    const commented = {
      path: OTHER,
      source: `// this provider must never call fetch() directly; it uses the base\nexport class X {}`,
    }
    assert.deepEqual(auditKeyProviderSsrf([goodBase, commented]), [])
  })

  test('the base failing to route through safeFetch is a violation', ({ assert }) => {
    const brokenBase = {
      path: BASE,
      source: `export default abstract class HttpKeyProvider { async request(r) { return fetch(r.url) } }`,
    }
    const problems = auditKeyProviderSsrf([brokenBase])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /must import and route every outbound through core safeFetch/)
  })

  test('presence floor: a missing egress base fails (never a vacuous pass)', ({ assert }) => {
    const problems = auditKeyProviderSsrf([
      { path: 'packages/crypto/src/services/env_key_provider.ts', source: `export class Env {}` },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /presence floor/)
  })
})
