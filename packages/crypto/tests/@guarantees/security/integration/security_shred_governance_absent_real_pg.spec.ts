import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import {
  addTenantSchema,
  createWormLedger,
  dropTenantSchema,
  dropWormLedger,
  probePg,
  serviceAs,
  tenant,
  type TenantSchema,
} from '../../../helpers/real_crypto_pg.js'

/**
 * The governance gate end-to-end on real Postgres: when governance is not installed
 * (no erasability resolver wired), a crypto-shred is refused before it destroys or audits
 * anything, and the DEK survives so the field still decrypts. crypto never erases on its
 * own initiative: under-erasing is recoverable, over-erasing is not. This is the
 * integration proof for the governance-absent half of the interlock (the unit proof is
 * security_shred_governance_absent_refused.spec.ts). Self-skips when Postgres is
 * unreachable (local), runs in CI.
 */
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const CAT = 'marketing'
const TEST_KEY = 'crypto-int-gov-absent-key-0000000000!'

let ready = false
let originalAppKey: string | undefined

test.group('crypto shred: governance absent refuses (real Postgres)', (group) => {
  group.setup(async () => {
    ready = await probePg()
    if (!ready) return
    originalAppKey = process.env.APP_KEY
    process.env.APP_KEY = TEST_KEY
    await createWormLedger()
    return async () => {
      await dropWormLedger()
      if (originalAppKey === undefined) delete process.env.APP_KEY
      else process.env.APP_KEY = originalAppKey
    }
  })

  test('a shred with no erasability resolver is refused and the DEK survives', async ({
    assert,
  }) => {
    const T = randomUUID()
    const s = `crypto_ga_${suffix}_${T.slice(0, 8)}`
    const c = `crypto_ga_conn_${suffix}_${T.slice(0, 8)}`
    const routes: Record<string, TenantSchema> = { [T]: await addTenantSchema(s, c) }
    try {
      // Ledger wired, but no erasability resolver, so governance is absent.
      const svc = serviceAs(T, { routes, withLedger: true })
      const ciphertext = await svc.encryptField(tenant(T), 'renter-1', CAT, 'x')

      await assert.rejects(() => svc.shred(tenant(T), 'renter-1', CAT), /governance absent/)

      // The DEK survived: the value still decrypts (nothing was destroyed).
      assert.equal(await svc.decryptField(tenant(T), 'renter-1', CAT, ciphertext), 'x')
    } finally {
      await dropTenantSchema(s, c)
    }
  }).skip(() => !ready, 'postgres not available; runs in CI')
})
