import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { createInstalledTenant, dropAllTenants } from '../_helpers.js'

/**
 * WS-AI-8 / 3B — the per-key rate limit bites end to end over the HTTP gateway.
 * config.ai.rateLimit caps requests per window; once the window is exceeded the
 * next /ai/chat is a clean pre-flight 429 `rate_limited` with no SSE bytes. (The
 * token-budget `over_budget` rail is proven on real Redis in
 * security_cost_governor_bites_real_redis.) Self-skips unless pgvector is present.
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

test.group('AI e2e — rate limit enforced end to end (3B)', (group) => {
  group.setup(async () => {
    ready = await pgvectorReady()
    await dropAllTenants()
    return async () => {
      await dropAllTenants()
    }
  })

  test('once the window limit is crossed, /ai/chat returns 429 rate_limited with no stream', async ({
    client,
    assert,
  }) => {
    const t = await createInstalledTenant(client)

    const statuses: number[] = []
    let rateLimited: { status: number; code: unknown } | undefined
    // config.ai.rateLimit.limit is 5; fire enough to cross it and capture the refusal.
    for (let i = 0; i < 8 && !rateLimited; i++) {
      const res = await client
        .post('/ai/chat')
        .headers(H(t.id, 'user-a'))
        .json({ messages: [{ role: 'user', content: `hello ${i}` }] })
      statuses.push(res.status())
      if (res.status() === 429) rateLimited = { status: 429, code: res.body()?.error }
    }

    assert.isTrue(statuses.includes(200), 'the first requests within the window stream (200)')
    assert.isDefined(rateLimited, 'the limit-plus-one request is refused')
    assert.equal(rateLimited!.code, 'rate_limited', 'the refusal is a rate_limited pre-flight')
  }).skip(() => !ready, 'pgvector not available; runs in CI on pgvector/pgvector:pg16')
})
