import { test } from '@japa/runner'
import {
  SCOPE_BYPASS_ACTION,
  allowScopeBypassAudit,
  scopeBypassEntry,
  __resetScopeBypassAuditRateLimit,
} from '../../../../src/models/scope_bypass_audit.js'

/**
 * WS-6: the emit/label/rate-limit logic for the scope-bypass audit, tested
 * deterministically. The end-to-end emission (an unscoped() bypass writing a real
 * tenant_audit_logs row) is covered in the security/integration tier.
 */

test.group('scope bypass audit — entry shape', () => {
  test('records the canonical action and the caller reason', ({ assert }) => {
    const entry = scopeBypassEntry('nightly cross-tenant report', 't-123')
    assert.equal(entry.action, SCOPE_BYPASS_ACTION)
    assert.equal(entry.action, 'scope:bypass')
    assert.equal(entry.tenantId, 't-123')
    assert.equal(entry.actorType, 'system')
    assert.deepEqual(entry.metadata, { reason: 'nightly cross-tenant report' })
  })

  test('a reasonless bypass still records (reason null), with the tenant context', ({ assert }) => {
    const entry = scopeBypassEntry(undefined, null)
    assert.deepEqual(entry.metadata, { reason: null })
    assert.isNull(entry.tenantId)
  })
})

test.group('scope bypass audit — rate limit', (group) => {
  group.each.setup(() => __resetScopeBypassAuditRateLimit())
  group.each.teardown(() => __resetScopeBypassAuditRateLimit())

  test('allows up to the cap within a window, then suppresses the burst', ({ assert }) => {
    const now = 1_000_000
    let allowed = 0
    for (let i = 0; i < 200; i++) {
      if (allowScopeBypassAudit(now)) allowed++
    }
    assert.equal(allowed, 50, 'the fixed-window cap bounds the burst')
  })

  test('the window resets so a later burst is allowed again', ({ assert }) => {
    const t0 = 5_000_000
    for (let i = 0; i < 100; i++) allowScopeBypassAudit(t0)
    // Move past the 10s window.
    assert.isTrue(allowScopeBypassAudit(t0 + 10_001), 'a new window admits events again')
  })
})
