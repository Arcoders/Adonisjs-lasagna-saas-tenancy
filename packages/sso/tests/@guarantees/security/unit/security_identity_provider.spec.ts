import { test } from '@japa/runner'
import { IdentityProviderRegistry } from '../../../../src/identity_provider.js'
import { SSO_CONTRACT_VERSION } from '../../../../src/constants.js'
import type { IdentityProviderContract } from '../../../../src/identity_provider.js'

function provider(
  name: string,
  contractVersion: number | undefined = SSO_CONTRACT_VERSION
): IdentityProviderContract {
  return {
    name,
    contractVersion,
    buildAuthUrl: async () => `https://idp.example.com/${name}/authorize`,
    handleCallback: async () => ({ tenantId: 't-1', claims: {} as any }),
  }
}

test.group('IdentityProviderRegistry', () => {
  test('register / get / has / list round-trip', ({ assert }) => {
    const reg = new IdentityProviderRegistry()
    reg.register(provider('saml')).register(provider('cas'))
    assert.isTrue(reg.has('saml'))
    assert.deepEqual([...reg.list()].sort(), ['cas', 'saml'])
    assert.equal(reg.contractVersion, SSO_CONTRACT_VERSION)
  })

  test('reserves the "oidc" name for the built-in provider', ({ assert }) => {
    const reg = new IdentityProviderRegistry()
    assert.throws(() => reg.register(provider('oidc')), /"oidc" is reserved/)
  })

  test('rejects a duplicate name', ({ assert }) => {
    const reg = new IdentityProviderRegistry()
    reg.register(provider('saml'))
    assert.throws(() => reg.register(provider('saml')), /already registered/)
  })

  test('rejects a provider built for a NEWER contract', ({ assert }) => {
    const reg = new IdentityProviderRegistry()
    assert.throws(
      () => reg.register(provider('future', SSO_CONTRACT_VERSION + 1)),
      /requires extension contract/
    )
    assert.isFalse(reg.has('future'))
  })

  test('rejects a provider with an empty or non-string name', ({ assert }) => {
    const reg = new IdentityProviderRegistry()
    assert.throws(() => reg.register(provider('')), /non-empty name/)
    assert.throws(
      () => reg.register({ ...provider('x'), name: 123 as unknown as string }),
      /non-empty name/
    )
  })

  test('clear() empties the registry', ({ assert }) => {
    const reg = new IdentityProviderRegistry()
    reg.register(provider('saml'))
    assert.isTrue(reg.has('saml'))
    reg.clear()
    assert.isFalse(reg.has('saml'))
    assert.deepEqual([...reg.list()], [])
  })
})
