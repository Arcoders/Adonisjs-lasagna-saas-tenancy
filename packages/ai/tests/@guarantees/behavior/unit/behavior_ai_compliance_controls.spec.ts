import { test } from '@japa/runner'
import {
  aiDataResidencyControl,
  aiRightToErasureControl,
  aiEmbeddingRetentionControl,
} from '../../../../src/services/ai_compliance_controls.js'

/**
 * Compliance posture controls: residency reports its configured/unset
 * posture, right-to-erasure is satisfied by the purge command + auto-purge, and
 * the embedding-retention control is INFO (not "satisfied erasure") so an
 * operator is never misled that anonymize cleared the corpus.
 */

const ctx = (ai: unknown) => ({ config: { ai } as never, db: {} as never })

test.group('behavior: AI compliance controls', () => {
  test('residency reports satisfied when configured, info when unset', async ({ assert }) => {
    const on = await aiDataResidencyControl.detect(
      ctx({ residency: () => ({ mode: 'local-only' }) })
    )
    assert.equal(on.status, 'satisfied')
    const off = await aiDataResidencyControl.detect(ctx({}))
    assert.equal(off.status, 'info')
    assert.includeMembers(aiDataResidencyControl.frameworks, ['gdpr:art30'])
  })

  test('right-to-erasure is satisfied and maps to gdpr:art17', async ({ assert }) => {
    const r = await aiRightToErasureControl.detect(ctx({}))
    assert.equal(r.status, 'satisfied')
    assert.match(r.evidence, /tenant:ai:purge/)
    assert.includeMembers(aiRightToErasureControl.frameworks, ['gdpr:art17'])
  })

  test('embedding retention is INFO with a host-responsibility, never satisfied erasure', async ({
    assert,
  }) => {
    const r = await aiEmbeddingRetentionControl.detect(ctx({ embedding: {} }))
    assert.equal(r.status, 'info')
    assert.match(r.evidence, /does NOT delete embeddings/)
    assert.match(r.hostResponsibility, /tenant:ai:purge/)
  })
})
