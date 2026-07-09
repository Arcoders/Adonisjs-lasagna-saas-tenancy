import { test } from '@japa/runner'
// The I7 scaffold guard is a repo-root script; import its pure auditor to exercise
// the governance-gate-first discipline on the shred path.
import { auditShredGate } from '../../../../../scripts/check-crypto-invariant-7.mjs'

const PATH = 'packages/crypto/src/services/crypto_service.ts'

function svc(shredBody: string): string {
  return `export default class CryptoService {\n  async shred(tenant, subjectId, category) {\n${shredBody}\n  }\n}\n`
}

const GOOD = `
    if (!this.#erasabilityResolver) { throw new Error('refused') }
    const verdict = await this.#erasabilityResolver(tenant, subjectId, category)
    if (!verdict.erasable) { throw new Error('refused') }
    const live = await this.#store.findLive(tenant, subjectId, category)
    if (!live) return { shredded: false }
    const pending = await this.#ledger.appendPending({})
    await this.#store.shredLive(tenant, subjectId, category)
    await this.#ledger.markCommitted(pending)`

test.group('architectural — I7 shred governance gate', () => {
  test('a gate-first shred passes', ({ assert }) => {
    assert.deepEqual(auditShredGate([{ path: PATH, source: svc(GOOD) }]), [])
  })

  test('a missing absent-governance refusal is a violation', ({ assert }) => {
    const body = GOOD.replace(
      `    if (!this.#erasabilityResolver) { throw new Error('refused') }\n`,
      ''
    )
    const problems = auditShredGate([{ path: PATH, source: svc(body) }])
    assert.isTrue(problems.some((p: string) => /absent-governance/.test(p)))
  })

  test('the first awaited call not being the resolver is a violation', ({ assert }) => {
    const body = `
    if (!this.#erasabilityResolver) { throw new Error('refused') }
    const live = await this.#store.findLive(tenant, subjectId, category)
    const verdict = await this.#erasabilityResolver(tenant, subjectId, category)
    await this.#store.shredLive(tenant, subjectId, category)`
    const problems = auditShredGate([{ path: PATH, source: svc(body) }])
    assert.isTrue(problems.some((p: string) => /FIRST awaited call/.test(p)))
  })

  test('a delete reachable before the gate is a violation', ({ assert }) => {
    const body = `
    if (!this.#erasabilityResolver) { throw new Error('refused') }
    await this.#store.shredLive(tenant, subjectId, category)
    const verdict = await this.#erasabilityResolver(tenant, subjectId, category)`
    const problems = auditShredGate([{ path: PATH, source: svc(body) }])
    assert.isTrue(problems.some((p: string) => /only after the governance gate/.test(p)))
  })
})
