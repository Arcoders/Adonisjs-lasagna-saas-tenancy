import { test } from '@japa/runner'
import { randomBytes } from 'node:crypto'
import VaultKeyProvider from '../../../src/services/vault_key_provider.js'

/**
 * Real-dependency smoke for the reference {@link VaultKeyProvider} (HashiCorp Vault transit
 * engine), gated on `VAULT_ADDR` + `VAULT_TOKEN` the way the billing Stripe smoke gates on
 * `STRIPE_TEST_API_KEY`. When those are set it wraps a random 32-byte DEK against a real
 * Vault, unwraps it, and asserts the round-trip, catching drift in Vault's transit API
 * shape and proving the SSRF-pinned egress reaches an allowed backend. Skipped (never
 * failed) when the env is unset, so the default `test:integration` run stays hermetic.
 *
 * Setup: `vault secrets enable transit` and `vault write -f transit/keys/lasagna-crypto-<tenant>`
 * (or enable upsert), then run with VAULT_ADDR / VAULT_TOKEN set.
 */
const ADDR = process.env.VAULT_ADDR
const TOKEN = process.env.VAULT_TOKEN
const gated = !ADDR || !TOKEN

test.group('crypto VaultKeyProvider: real wrap/unwrap round-trip (gated)', () => {
  test('wraps and unwraps a DEK against a real Vault transit key', async ({ assert }) => {
    const provider = new VaultKeyProvider({
      address: ADDR!,
      token: TOKEN!,
      keyPrefix: process.env.VAULT_KEY_PREFIX ?? 'lasagna-crypto-',
    })
    const tenantId = process.env.VAULT_TEST_TENANT ?? 'smoke-tenant'
    const dek = randomBytes(32)

    const wrapped = await provider.wrapDek(tenantId, dek)
    assert.isString(wrapped.ciphertext)
    assert.match(wrapped.kekId, /^v\d+$/) // Vault transit key version cursor

    const unwrapped = await provider.unwrapDek(tenantId, wrapped)
    assert.isTrue(unwrapped.equals(dek), 'the unwrapped DEK must equal the original')

    // The current-generation cursor is reportable (drives an efficient rekek skip).
    const current = await provider.currentKekId(tenantId)
    assert.match(current, /^v\d+$/)
  }).skip(gated, 'VAULT_ADDR / VAULT_TOKEN not set, real Vault smoke skipped')
})
