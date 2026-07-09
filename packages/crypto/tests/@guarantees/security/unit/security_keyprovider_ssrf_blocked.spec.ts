import { test } from '@japa/runner'
import { randomBytes } from 'node:crypto'
import VaultKeyProvider from '../../../../src/services/vault_key_provider.js'
import CryptoException from '../../../../src/exceptions/crypto_exception.js'

// T13 (§3, §8): "Point a KeyProvider HTTP backend at an internal URL." Because every
// HTTP-backed KeyProvider extends HttpKeyProvider, which routes ALL outbound through
// core safeFetch (the SSRF pin), a backend address aimed at cloud-metadata / loopback /
// RFC-1918 is blocked BEFORE any request is sent, and the wrap/unwrap fails closed
// (`keyprovider_unavailable`) — it never reaches the internal address, and never falls
// back to a weaker path. `check-crypto-invariant-11` pins that there is no second,
// unpinned egress; this proves the pin actually blocks a hostile address at runtime.
test.group('crypto KeyProvider SSRF pin (T13) — internal addresses are blocked fail-closed', () => {
  const DEK = randomBytes(32)

  const blocked = [
    { label: 'cloud-metadata (link-local)', address: 'http://169.254.169.254' },
    { label: 'loopback', address: 'http://127.0.0.1:9' },
    { label: 'RFC-1918 private', address: 'http://10.0.0.1' },
  ]

  for (const { label, address } of blocked) {
    test(`wrapDek against ${label} is blocked by the SSRF pin`, async ({ assert }) => {
      const provider = new VaultKeyProvider({ address, token: 't', timeoutMs: 2000 })
      const error = await provider.wrapDek('tenant-1', DEK).then(
        () => null,
        (e: unknown) => e
      )
      assert.instanceOf(error, CryptoException)
      assert.equal((error as CryptoException).code, 'keyprovider_unavailable')
    })
  }
})
