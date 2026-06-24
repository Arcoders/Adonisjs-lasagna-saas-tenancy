import { test } from '@japa/runner'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Guards the hand-maintained reference docs against the code they describe.
 * Every assertion here pins a real drift that already happened once (events.md
 * billing field renamed to `subscriptionId`, the impersonation default, an ace
 * command missing from the reference, etc.). These pages are synced by hand, so
 * without a test they rot silently — this is the cheap automated backstop.
 */

const corePath = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url))
const docsDir = fileURLToPath(new URL('../../../../../docs/docs/', import.meta.url))
const docPath = (rel: string) => `${docsDir}${rel}`

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

/** Every markdown file under docs/docs, recursively. */
function allDocs(dir: string = docsDir): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}${entry.name}`
    if (entry.isDirectory()) out.push(...allDocs(`${full}/`))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

test.group('docs vs code contract', () => {
  test('no doc still references the renamed billing field stripeSubscriptionId', ({ assert }) => {
    const offenders = allDocs().filter((f) => read(f).includes('stripeSubscriptionId'))
    assert.deepEqual(
      offenders.map((f) => f.replace(docsDir, '')),
      [],
      'billing events expose `subscriptionId` (provider-agnostic), not `stripeSubscriptionId`'
    )
  })

  test('events.md documents the QuotaTracked payload field as newTotal, not total', ({ assert }) => {
    const events = read(docPath('events.md'))
    assert.include(events, '`amount`, `newTotal`', 'QuotaTracked 4th field is `newTotal`')
    assert.notInclude(
      events,
      '`amount`, `total`',
      'the stale `total` field name must not reappear'
    )
  })

  test('events.md documents the public metrics events', ({ assert }) => {
    const events = read(docPath('events.md'))
    assert.include(events, 'MetricRecorded')
    assert.include(events, 'MetricsFlushed')
  })

  test('the documented impersonation default matches DEFAULT_DURATION in code', ({ assert }) => {
    const source = read(corePath('src/services/impersonation_service.ts'))
    const match = source.match(/DEFAULT_DURATION\s*=\s*([0-9*\s]+)/)
    assert.isNotNull(match, 'could not locate DEFAULT_DURATION in impersonation_service.ts')
    // The expression is digits and `*` only (e.g. `15 * 60`); evaluate it safely.
    const expr = match![1].trim()
    assert.match(expr, /^[0-9*\s]+$/)
    const seconds = expr
      .split('*')
      .map((n) => Number(n.trim()))
      .reduce((a, b) => a * b, 1)

    const config = read(corePath('src/types/config.ts'))
    assert.include(
      config,
      `Default: ${seconds} (`,
      'config.ts JSDoc must document the real default'
    )

    const configuration = read(docPath('configuration.md'))
    assert.include(
      configuration,
      `\`impersonation.defaultDuration\` | \`number\` | \`${seconds}\``,
      'configuration.md must document the real default'
    )
  })

  test('every ace command in commands.json is documented in commands.md', ({ assert }) => {
    const manifest = JSON.parse(read(corePath('src/commands/commands.json'))) as {
      commands?: Array<{ commandName?: string }>
    }
    const md = read(docPath('commands.md'))
    const names = (manifest.commands ?? []).map((c) => c.commandName).filter(Boolean) as string[]
    const undocumented = names.filter((name) => !md.includes(name))
    assert.deepEqual(undocumented, [], 'add the missing command(s) to docs/docs/commands.md')
  })
})
