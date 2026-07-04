import { test } from '@japa/runner'
// The I6 scaffold guard is a repo-root script; import its pure auditor to exercise
// the shred-path discipline: no unwrapped DEK, exactly one delete, audit-before-delete.
import { auditShredScaffold } from '../../../../../scripts/check-crypto-invariant-6.mjs'

const PATH = 'packages/crypto/src/services/crypto_service.ts'

/** Wrap a shred method body in a class so `async shred(` is found. */
function svc(shredBody: string): string {
  return `export default class CryptoService {\n  async shred(tenant, subjectId, category) {\n${shredBody}\n  }\n}\n`
}

const GOOD = `
    if (!this.#erasabilityResolver) { throw new Error('refused') }
    const verdict = await this.#erasabilityResolver(tenant, subjectId, category)
    if (!verdict.erasable) { throw new Error('refused') }
    const live = await this.#store.findLive(tenant, subjectId, category)
    if (!live) return { shredded: false }
    if (!this.#ledger) { throw new Error('unaudited') }
    const pending = await this.#ledger.appendPending({})
    await this.#store.shredLive(tenant, subjectId, category)
    await this.#ledger.markCommitted(pending)
    return { shredded: true }`

test.group('architectural — I6 shred scaffold', () => {
  test('a gate-first, single-delete, audited shred passes', ({ assert }) => {
    assert.deepEqual(auditShredScaffold([{ path: PATH, source: svc(GOOD) }]), [])
  })

  test('binding an unwrapDek result on the shred path is a violation', ({ assert }) => {
    const body = GOOD.replace(
      `    if (!this.#ledger) { throw new Error('unaudited') }`,
      `    const raw = await this.#keyProvider.unwrapDek(tenant.id, live)\n    if (!this.#ledger) { throw new Error('unaudited') }`
    )
    const problems = auditShredScaffold([{ path: PATH, source: svc(body) }])
    assert.isTrue(problems.some((p: string) => /unwrapDek/.test(p)))
  })

  test('more than one DEK-destroy is a violation', ({ assert }) => {
    const body = GOOD.replace(
      `    await this.#ledger.markCommitted(pending)`,
      `    await this.#store.shredLive(tenant, subjectId, category)\n    await this.#ledger.markCommitted(pending)`
    )
    const problems = auditShredScaffold([{ path: PATH, source: svc(body) }])
    assert.isTrue(problems.some((p: string) => /EXACTLY ONE/.test(p)))
  })

  test('the PENDING append after the delete (unaudited erasure) is a violation', ({ assert }) => {
    const body = `
    const verdict = await this.#erasabilityResolver(tenant, subjectId, category)
    await this.#store.shredLive(tenant, subjectId, category)
    const pending = await this.#ledger.appendPending({})`
    const problems = auditShredScaffold([{ path: PATH, source: svc(body) }])
    assert.isTrue(problems.some((p: string) => /precede/.test(p)))
  })
})
