import { test } from '@japa/runner'
import {
  createGuardAudit,
  MAX_ISTHMUS_METADATA_KEYS,
  MAX_ISTHMUS_METADATA_VALUE_LENGTH,
  type GuardAuditEntry,
} from '../../../../src/sdk/guard_audit.js'
import { tokenizeTenantId, TENANT_TOKEN_PREFIX } from '../../../../src/sdk/tenant_token.js'
import type { IsthmusGuardTrippedPayload } from '../../../../src/types/isthmus.js'

/**
 * The Isthmus event fans out process-wide to every subscribed plugin. Two S1
 * guarantees keep that fan-out from becoming a disclosure/amplification surface:
 *
 *   1. Metadata is bounded at the single emit seam (key count + value length).
 *      Over-limit metadata is TRUNCATED, never dropped wholesale, and the clip is
 *      counted (`dropped{metadata_bounded}`) so nothing is silently lost.
 *   2. A foreign tenant id placed in metadata is TOKENIZED (non-reversible), so a
 *      plugin listener cannot harvest a real cross-tenant identifier; the precise
 *      ids stay server-side in the typed exception + tenant-scoped audit log.
 */

const ENTRY: GuardAuditEntry = {
  id: 'guard.synthetic',
  pillar: 'guard',
  bugClass: 'metadata-contract-test',
  severity: 'high',
  event: 'isthmus:guard:synthetic:rejected',
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function makeAudit() {
  const captured: IsthmusGuardTrippedPayload[] = []
  const audit = createGuardAudit<'guard.synthetic'>({ lookup: () => ENTRY })
  audit.setDispatcher(async (payload) => {
    captured.push(payload)
  })
  return { audit, captured }
}

test.group('Isthmus metadata contract — bounded broadcast', () => {
  test('keeps at most MAX keys and counts the clip', async ({ assert }) => {
    const { audit, captured } = makeAudit()
    const metadata: Record<string, number> = {}
    for (let i = 0; i < MAX_ISTHMUS_METADATA_KEYS + 8; i++) metadata[`k${i}`] = i

    audit.emit('guard.synthetic', { metadata })
    await settle()

    assert.lengthOf(captured, 1)
    assert.equal(
      Object.keys(captured[0]!.metadata).length,
      MAX_ISTHMUS_METADATA_KEYS,
      'the broadcast carries at most the key ceiling'
    )
    const dropped = audit.snapshot().dropped.find((d) => d.reason === 'metadata_bounded')
    assert.equal(dropped?.value, 1, 'the clip is counted, never silent')
  })

  test('clips an over-long string value to MAX length and counts it', async ({ assert }) => {
    const { audit, captured } = makeAudit()
    const long = 'x'.repeat(MAX_ISTHMUS_METADATA_VALUE_LENGTH + 500)

    audit.emit('guard.synthetic', { metadata: { blob: long } })
    await settle()

    assert.equal(
      (captured[0]!.metadata.blob as string).length,
      MAX_ISTHMUS_METADATA_VALUE_LENGTH,
      'a long value is clipped to the value ceiling'
    )
    assert.isDefined(audit.snapshot().dropped.find((d) => d.reason === 'metadata_bounded'))
  })

  test('within-bounds metadata is untouched and not counted as bounded', async ({ assert }) => {
    const { audit, captured } = makeAudit()

    audit.emit('guard.synthetic', { metadata: { reason: 'denied', count: 3 } })
    await settle()

    assert.deepEqual(captured[0]!.metadata, { reason: 'denied', count: 3 })
    assert.isUndefined(
      audit.snapshot().dropped.find((d) => d.reason === 'metadata_bounded'),
      'metadata within bounds never records a clip'
    )
  })

  test('a count-only trip never bounds metadata (nothing is broadcast)', async ({ assert }) => {
    const { audit, captured } = makeAudit()
    const metadata: Record<string, number> = {}
    for (let i = 0; i < MAX_ISTHMUS_METADATA_KEYS + 8; i++) metadata[`k${i}`] = i

    audit.emit('guard.synthetic', { metadata, dispatch: false })
    await settle()

    assert.lengthOf(captured, 0, 'a count-only trip never broadcasts')
    assert.isUndefined(audit.snapshot().dropped.find((d) => d.reason === 'metadata_bounded'))
  })
})

test.group('Isthmus tenant-id tokenization', () => {
  const A = '11111111-1111-4111-8111-111111111111'
  const B = '22222222-2222-4222-8222-222222222222'

  test('the token is not the raw id, is prefixed, and never contains it', ({ assert }) => {
    const token = tokenizeTenantId(A)
    assert.notEqual(token, A, 'the token is not the raw id')
    assert.isTrue(token.startsWith(TENANT_TOKEN_PREFIX), 'the token is recognisably prefixed')
    assert.isFalse(token.includes(A), 'the raw id never appears inside the token')
  })

  test('a foreign id tokenizes stably; distinct ids yield distinct tokens', ({ assert }) => {
    assert.equal(tokenizeTenantId(A), tokenizeTenantId(A), 'stable within the process')
    assert.notEqual(tokenizeTenantId(A), tokenizeTenantId(B), 'distinct ids, distinct tokens')
  })
})
