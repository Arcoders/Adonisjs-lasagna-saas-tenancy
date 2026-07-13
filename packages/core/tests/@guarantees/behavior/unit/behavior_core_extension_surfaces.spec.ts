import { test } from '@japa/runner'
import WebhookTransformerRegistry from '../../../../src/services/webhook_transformer_registry.js'
import AuditLogDestinationRegistry, {
  AUDIT_CONTRACT_VERSION,
} from '../../../../src/services/audit_log_destination_registry.js'
import EvaluationStrategyRegistry, {
  DEFAULT_EVALUATION_STRATEGY,
  FEATURE_FLAGS_CONTRACT_VERSION,
} from '../../../../src/services/evaluation_strategy_registry.js'
import { WEBHOOKS_CONTRACT_VERSION } from '../../../../src/services/webhook_transformer_registry.js'
import type { FeatureFlagRecord } from '../../../../src/services/feature_flag_service.js'

/** Run `fn` with console.warn captured (the registries warn via the console
 *  fallback for older/unversioned extensions). */
function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
  try {
    return { result: fn(), warnings }
  } finally {
    console.warn = original
  }
}

test.group('WebhookTransformerRegistry', () => {
  test('registers, lists in order, and applies the chain', ({ assert }) => {
    const reg = new WebhookTransformerRegistry()
    reg.register({
      name: 'wrap',
      contractVersion: WEBHOOKS_CONTRACT_VERSION,
      transform: (_e, p) => ({ ...p, wrapped: true }),
    })
    reg.register({
      name: 'stamp',
      contractVersion: WEBHOOKS_CONTRACT_VERSION,
      transform: (event, p) => ({ ...p, event }),
    })
    assert.deepEqual(
      reg.list().map((t) => t.name),
      ['wrap', 'stamp']
    )
    assert.deepEqual(reg.apply('user.created', { id: 1 }), {
      id: 1,
      wrapped: true,
      event: 'user.created',
    })
  })

  test('rejects a duplicate and an empty name', ({ assert }) => {
    const reg = new WebhookTransformerRegistry()
    reg.register({ name: 'a', contractVersion: WEBHOOKS_CONTRACT_VERSION, transform: (_e, p) => p })
    assert.throws(
      () =>
        reg.register({
          name: 'a',
          contractVersion: WEBHOOKS_CONTRACT_VERSION,
          transform: (_e, p) => p,
        }),
      /already registered/
    )
    assert.throws(() => reg.register({ name: '', transform: (_e, p) => p }), /non-empty/)
  })

  test('apply throws when a transformer returns a non-object', ({ assert }) => {
    const reg = new WebhookTransformerRegistry()
    reg.register({
      name: 'bad',
      contractVersion: WEBHOOKS_CONTRACT_VERSION,
      transform: () => 'nope' as unknown as Record<string, unknown>,
    })
    assert.throws(() => reg.apply('e', {}), /must return a plain object/)
  })

  test('rejects a transformer built for a NEWER contract', ({ assert }) => {
    const reg = new WebhookTransformerRegistry()
    assert.throws(
      () =>
        reg.register({
          name: 'future',
          contractVersion: WEBHOOKS_CONTRACT_VERSION + 1,
          transform: (_e, p) => p,
        }),
      /requires extension contract/
    )
  })
})

test.group('AuditLogDestinationRegistry', () => {
  test('registers and lists destinations', ({ assert }) => {
    const reg = new AuditLogDestinationRegistry()
    reg.register({ name: 'datadog', contractVersion: AUDIT_CONTRACT_VERSION, write: () => {} })
    assert.isTrue(reg.has('datadog'))
    assert.deepEqual(
      reg.list().map((d) => d.name),
      ['datadog']
    )
  })

  test('an unversioned destination warns but still registers', ({ assert }) => {
    const reg = new AuditLogDestinationRegistry()
    const { warnings } = captureWarn(() => reg.register({ name: 'legacy', write: () => {} }))
    assert.isTrue(reg.has('legacy'))
    assert.lengthOf(warnings, 1)
    assert.match(warnings[0]!, /does not declare a contractVersion/)
  })

  test('rejects a destination built for a NEWER contract', ({ assert }) => {
    const reg = new AuditLogDestinationRegistry()
    assert.throws(
      () =>
        reg.register({
          name: 'future',
          contractVersion: AUDIT_CONTRACT_VERSION + 1,
          write: () => {},
        }),
      /requires extension contract/
    )
  })
})

test.group('EvaluationStrategyRegistry', () => {
  const record = (over: Partial<FeatureFlagRecord> = {}): FeatureFlagRecord => ({
    enabled: true,
    config: null,
    expiresAt: null,
    ...over,
  })

  test('default strategy: enabled and not expired → true; disabled/expired → false', ({
    assert,
  }) => {
    const ctx = { tenantId: 't', flag: 'f' }
    assert.isTrue(DEFAULT_EVALUATION_STRATEGY.evaluate(record(), ctx))
    assert.isFalse(DEFAULT_EVALUATION_STRATEGY.evaluate(record({ enabled: false }), ctx))
    assert.isFalse(
      DEFAULT_EVALUATION_STRATEGY.evaluate(record({ expiresAt: '2000-01-01T00:00:00Z' }), ctx)
    )
  })

  test('resolve() returns the default when unknown or omitted', ({ assert }) => {
    const reg = new EvaluationStrategyRegistry()
    assert.equal(reg.resolve().name, 'default')
    assert.equal(reg.resolve('nope').name, 'default')
    assert.deepEqual([...reg.list()], ['default'])
  })

  test('registers a custom strategy and resolves it', ({ assert }) => {
    const reg = new EvaluationStrategyRegistry()
    reg.register({
      name: 'always_on',
      contractVersion: FEATURE_FLAGS_CONTRACT_VERSION,
      evaluate: () => true,
    })
    assert.isTrue(
      reg.resolve('always_on').evaluate(record({ enabled: false }), { tenantId: 't', flag: 'f' })
    )
  })

  test('reserves the "default" name and rejects duplicates + newer contracts', ({ assert }) => {
    const reg = new EvaluationStrategyRegistry()
    assert.throws(
      () => reg.register({ name: 'default', evaluate: () => true }),
      /"default" is reserved/
    )
    reg.register({
      name: 'x',
      contractVersion: FEATURE_FLAGS_CONTRACT_VERSION,
      evaluate: () => true,
    })
    assert.throws(
      () =>
        reg.register({
          name: 'x',
          contractVersion: FEATURE_FLAGS_CONTRACT_VERSION,
          evaluate: () => true,
        }),
      /already registered/
    )
    assert.throws(
      () =>
        reg.register({
          name: 'future',
          contractVersion: FEATURE_FLAGS_CONTRACT_VERSION + 1,
          evaluate: () => true,
        }),
      /requires extension contract/
    )
  })
})
