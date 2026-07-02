import { test } from '@japa/runner'
import {
  aiRetrievalGateCheck,
  aiRetrievalGatePosture,
} from '../../../../src/services/ai_retrieval_gate_check.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * The ai_retrieval_gate doctor check + its shared posture reading (WS-AI-5, G2).
 * The posture is read at RUN time through the injected getter, and the boot
 * warning and the check speak with one voice (both read aiRetrievalGatePosture).
 * Retrieval is fail-closed: unwired + unacknowledged is a `warn` (retrieval is
 * refused); an acknowledged tenant-wide opt-in is an `info`.
 */

const embedding = { apiKey: 'k', baseUrl: 'https://emb.example' } as AiConfig['embedding']

function ai(over: Partial<AiConfig> = {}): AiConfig {
  return { allowedProviders: ['claude'], embedding, ...over }
}

test.group('ai_retrieval_gate doctor check', () => {
  test('no config.ai at all reports nothing (retrieval is not usable)', ({ assert }) => {
    assert.isNull(aiRetrievalGatePosture(undefined))
    assert.deepEqual(aiRetrievalGateCheck(() => undefined).run(), [])
  })

  test('no embedding provider reports nothing (retrieval routes cannot run)', ({ assert }) => {
    const noEmbedding = { allowedProviders: ['claude'] } as AiConfig
    assert.isNull(aiRetrievalGatePosture(noEmbedding))
    assert.deepEqual(aiRetrievalGateCheck(() => noEmbedding).run(), [])
  })

  test('a wired retrievalFilter is healthy (no issue)', ({ assert }) => {
    const scoped = ai({ retrieval: { retrievalFilter: () => ({ kind: 'all' }) } })
    assert.isNull(aiRetrievalGatePosture(scoped))
    assert.deepEqual(aiRetrievalGateCheck(() => scoped).run(), [])
  })

  test('embeddings usable but no filter and no acknowledgement is a warn (retrieval refused)', ({
    assert,
  }) => {
    const unscoped = ai()
    const posture = aiRetrievalGatePosture(unscoped)
    assert.isNotNull(posture)
    assert.equal(posture!.severity, 'warn')
    assert.include(posture!.message, 'fail-closed')
    assert.include(posture!.message, 'refused with 403')

    const issues = aiRetrievalGateCheck(() => unscoped).run()
    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'ai_retrieval_gate_refused')
    assert.equal(issues[0].severity, 'warn')
    assert.equal(issues[0].message, posture!.message)
  })

  test('an acknowledged tenant-wide posture is an info issue naming the consequence', ({
    assert,
  }) => {
    const acknowledged = ai({ acknowledgeUnscopedRetrieval: true })
    const posture = aiRetrievalGatePosture(acknowledged)
    assert.isNotNull(posture)
    assert.include(posture!.message, 'ENTIRE corpus')

    const issues = aiRetrievalGateCheck(() => acknowledged).run()
    assert.lengthOf(issues, 1)
    assert.equal(issues[0].code, 'ai_retrieval_gate_acknowledged')
    assert.equal(issues[0].severity, 'info')
  })

  test('the check reads config at run time (live posture, not registration time)', ({ assert }) => {
    let current = ai()
    const check = aiRetrievalGateCheck(() => current)
    assert.equal(check.run()[0]?.severity, 'warn')
    current = ai({ retrieval: { retrievalFilter: () => ({ kind: 'all' }) } })
    assert.deepEqual(check.run(), [])
  })
})
