import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { createInstalledTenant, dropAllTenants } from '../_helpers.js'

/**
 * WS-AI-8 / 3A — end-to-end two-tenant isolation over the real HTTP gateway.
 * Two tenants embed a distinct secret document; each tenant's /ai/retrieve returns
 * ONLY its own document, never the other tenant's, even though both use the same
 * source key. Runs fully offline through the demo's mock providers. Self-skips
 * unless Postgres has pgvector; runs in CI on pgvector/pgvector:pg16.
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

test.group('AI e2e — two-tenant embed/retrieve isolation (3A)', (group) => {
  group.setup(async () => {
    ready = await pgvectorReady()
    await dropAllTenants()
    return async () => {
      await dropAllTenants()
    }
  })

  test('a tenant retrieves only its own embedded documents, never another tenant’s', async ({
    client,
    assert,
  }) => {
    const a = await createInstalledTenant(client)
    const b = await createInstalledTenant(client)

    // Embed a distinct secret per tenant under the SAME source key.
    const embedA = await client
      .post('/ai/embed')
      .headers(H(a.id, 'user-a'))
      .json({ source: 'kb', input: ['secret-of-A: the refund window is 30 days'] })
    embedA.assertStatus(200)
    // Demo-layer check (review #2): the write succeeded, so SEAM-2 discovery + the AI
    // per-tenant migration created the tenant's ai_embeddings table.
    assert.equal(embedA.body().inserted, 1, 'the ai_embeddings table exists and took the row')

    const embedB = await client
      .post('/ai/embed')
      .headers(H(b.id, 'user-b'))
      .json({ source: 'kb', input: ['secret-of-B: the refund window is 7 days'] })
    embedB.assertStatus(200)

    // Tenant A retrieves: only A's content.
    const retA = await client
      .post('/ai/retrieve')
      .headers(H(a.id, 'user-a'))
      .json({ query: 'refund window', limit: 10 })
    retA.assertStatus(200)
    const aContents = (retA.body().matches as { content: string }[]).map((m) => m.content)
    assert.isTrue(
      aContents.some((c) => c.includes('secret-of-A')),
      'A sees its own document'
    )
    assert.isFalse(
      aContents.some((c) => c.includes('secret-of-B')),
      'A never sees tenant B'
    )

    // Tenant B retrieves: only B's content.
    const retB = await client
      .post('/ai/retrieve')
      .headers(H(b.id, 'user-b'))
      .json({ query: 'refund window', limit: 10 })
    retB.assertStatus(200)
    const bContents = (retB.body().matches as { content: string }[]).map((m) => m.content)
    assert.isTrue(
      bContents.some((c) => c.includes('secret-of-B')),
      'B sees its own document'
    )
    assert.isFalse(
      bContents.some((c) => c.includes('secret-of-A')),
      'B never sees tenant A'
    )
  }).skip(() => !ready, 'pgvector not available; runs in CI on pgvector/pgvector:pg16')
})
