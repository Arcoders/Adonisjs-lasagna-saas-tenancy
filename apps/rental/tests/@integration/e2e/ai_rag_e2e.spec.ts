import { test } from '@japa/runner'
import { realms, authHeaders } from './_helpers.js'

/**
 * The AI fleet assistant, end to end: RAG retrieval over the seeded per-tenant
 * corpus, the output DLP hook, and the SSRF pin on document ingestion. Kept to a
 * few calls per run because the AI gateway is rate-limited (10/60s per key).
 */
test.group('security — AI fleet assistant', () => {
  test('retrieval returns grounded matches from the company corpus', async ({ client, assert }) => {
    const { acme } = await realms(client)
    const res = await client
      .post('/ai/retrieve')
      .headers(authHeaders(acme))
      .header('x-ai-user', 'owner@karimoto.test')
      .json({ query: 'fuel policy and security deposit', limit: 3 })

    res.assertStatus(200)
    const matches = res.body().matches
    assert.isAtLeast(matches.length, 1)
    // Each hit carries its source doc's title (non-PII metadata), proving the
    // seeded FleetDoc corpus is what was searched — not an empty store.
    assert.exists(matches[0].metadata.title)
  })

  test('the assistant streams and redacts CIN-shaped output (DLP)', async ({ client, assert }) => {
    const { acme } = await realms(client)
    const res = await client
      .post('/ai/chat')
      .headers(authHeaders(acme))
      .header('x-ai-user', 'owner@karimoto.test')
      .json({ messages: [{ role: 'user', content: 'What is the fuel policy?' }] })

    res.assertStatus(200)
    const body = res.text()
    // The mock emits a CIN-shaped token; the config.ai.redactOutput DLP hook must
    // strip it from the stream before it reaches the client.
    assert.include(body, '[redacted]')
    assert.notInclude(body, 'AB123456')
  })

  test('a private document URL is refused by the SSRF pin', async ({ client, assert }) => {
    const { acme } = await realms(client)
    const res = await client
      .post('/ai/embed')
      .headers(authHeaders(acme))
      .header('x-ai-user', 'owner@karimoto.test')
      .json({
        source: 'ssrf-probe',
        input: ['probe'],
        // Link-local cloud-metadata address: the SSRF-pinned fetch must refuse it.
        sourceUrl: 'http://169.254.169.254/latest/meta-data/',
      })

    res.assertStatus(400)
    assert.equal(res.body().error, 'doc_fetch_blocked')
  })
})
