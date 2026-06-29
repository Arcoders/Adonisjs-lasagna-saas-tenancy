import { test } from '@japa/runner'
import {
  isClientControlledStrategy,
  resolutionIsClientControlled,
  membershipGateRisk,
} from '../../../../src/services/membership_gate.js'
import type { MultitenancyConfig } from '../../../../src/types/config.js'
import { testConfig } from '../../../helpers/config.js'

function cfg(overrides: Partial<MultitenancyConfig>): MultitenancyConfig {
  return { ...testConfig, ...overrides } as MultitenancyConfig
}

test.group('membership_gate — strategy classification', () => {
  test('header / path / request-data are client-controlled', ({ assert }) => {
    assert.isTrue(isClientControlledStrategy('header'))
    assert.isTrue(isClientControlledStrategy('path'))
    assert.isTrue(isClientControlledStrategy('request-data'))
  })

  test('subdomain / domain-or-subdomain / unknown custom are not', ({ assert }) => {
    assert.isFalse(isClientControlledStrategy('subdomain'))
    assert.isFalse(isClientControlledStrategy('domain-or-subdomain'))
    assert.isFalse(isClientControlledStrategy('my-custom-server-resolver'))
  })

  test('a chain is client-controlled when ANY member is', ({ assert }) => {
    assert.isTrue(resolutionIsClientControlled(cfg({ resolverChain: ['subdomain', 'header'] })))
    assert.isFalse(
      resolutionIsClientControlled(cfg({ resolverChain: ['subdomain', 'domain-or-subdomain'] }))
    )
  })

  test('an empty chain falls back to the single strategy', ({ assert }) => {
    assert.isTrue(
      resolutionIsClientControlled(cfg({ resolverChain: [], resolverStrategy: 'path' }))
    )
    assert.isFalse(
      resolutionIsClientControlled(cfg({ resolverChain: [], resolverStrategy: 'subdomain' }))
    )
  })
})

test.group('membership_gate — risk verdict', () => {
  test('client-controlled + no hook + not acknowledged => IDOR message', ({ assert }) => {
    const reason = membershipGateRisk(
      cfg({ resolverStrategy: 'header', authorizeTenantAccess: undefined })
    )
    assert.isNotNull(reason)
    assert.match(reason ?? '', /IDOR|membership|authorizeTenantAccess/)
  })

  test('a wired authorizeTenantAccess clears the risk', ({ assert }) => {
    const reason = membershipGateRisk(cfg({ authorizeTenantAccess: () => true }))
    assert.isNull(reason)
  })

  test('acknowledgeNoMembershipGate clears the risk', ({ assert }) => {
    const reason = membershipGateRisk(cfg({ acknowledgeNoMembershipGate: true }))
    assert.isNull(reason)
  })

  test('a server-controlled strategy is never flagged', ({ assert }) => {
    assert.isNull(membershipGateRisk(cfg({ resolverStrategy: 'subdomain' })))
    assert.isNull(membershipGateRisk(cfg({ resolverStrategy: 'domain-or-subdomain' })))
  })
})
