import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { createInstalledTenant, dropAllTenants } from '../_helpers.js'

/**
 * WS-AI-10 hardening / redaction — the optional host output-redaction (DLP) hook
 * runs end to end over the real HTTP gateway. The demo `config.ai.redactOutput`
 * strips an SSN-shaped token from the model's streamed output, so the raw PII
 * never reaches the client, while the mandatory output bound (I8) still applies.
 * Host-owned defense-in-depth, NEVER the isolation control (I4/I8 remain the
 * guarantee). Self-skips without pgvector (the AI e2e group shares the bootstrap).
 */
let ready = false

async function pgvectorReady(): Promise<boolean> {
  try {
    // The suite bootstrap installs pgvector into its dedicated schema; just probe.
    const r = await db
      .connection('public')
      .rawQuery(`SELECT 1 FROM pg_extension WHERE extname = 'vector'`)
    return (r.rows ?? []).length > 0
  } catch {
    return false
  }
}

const H = (id: string, user: string) => ({ 'x-tenant-id': id, 'x-ai-user': user })

test.group('AI e2e — output redaction end to end', (group) => {
  group.setup(async () => {
    ready = await pgvectorReady()
    await dropAllTenants()
    return async () => {
      await dropAllTenants()
    }
  })

  test('the redactOutput hook strips PII from the streamed model output', async ({
    client,
    assert,
  }) => {
    const t = await createInstalledTenant(client)

    const res = await client
      .post('/ai/chat')
      .headers(H(t.id, 'user-a'))
      .json({ messages: [{ role: 'user', content: 'show me the record' }] })

    res.assertStatus(200)
    const body = res.text()
    assert.include(body, '[redacted]', 'the DLP hook rewrote the model output in the SSE stream')
    assert.include(body, 'The record is', 'ordinary prose is preserved, only the PII is stripped')
    assert.notInclude(body, 'SSN-000-00-0000', 'the raw PII never reached the client')
  }).skip(() => !ready, 'pgvector not available; runs in CI on pgvector/pgvector:pg16')
})
