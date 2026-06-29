import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-8 / adonisjs-queue-0x-peer-frozen.
 *
 * The job classes `extends Job` from `@adonisjs/queue` (now an OPTIONAL peer), so
 * a top-level re-export of them from the package main entry would pull the queue
 * into the module graph of every `import '@adonisjs-lasagna/saas-tenancy'` and
 * break a host that doesn't run background jobs. The jobs live on the dedicated
 * `/jobs` subpath, which a queue-using host imports explicitly.
 *
 * RED (pre-fix): main index had `export { InstallTenant, ... } from './jobs'`.
 */
const MAIN_INDEX = fileURLToPath(new URL('../../../src/index.ts', import.meta.url))
const JOBS_INDEX = fileURLToPath(new URL('../../../src/jobs/index.ts', import.meta.url))
const RE = /export\s+(?:type\s+)?\{[^}]*\}\s+from\s+['"]\.\/jobs/

test.group('architectural — jobs do not pull the optional queue peer into the main graph', () => {
  test('the package main entry does not re-export the queue-backed job modules', ({ assert }) => {
    assert.notMatch(
      readFileSync(MAIN_INDEX, 'utf8'),
      RE,
      'main index must not re-export from ./jobs (it would force the optional @adonisjs/queue peer)'
    )
  })

  test('the /jobs subpath still exports them for queue-using hosts', ({ assert }) => {
    const src = readFileSync(JOBS_INDEX, 'utf8')
    assert.match(src, /InstallTenant/)
    assert.match(src, /TenantJob/)
  })

  test('detector control: the matcher catches a ./jobs re-export and ignores others', ({
    assert,
  }) => {
    assert.match("export { X } from './jobs/index.js'", RE)
    assert.notMatch("export { X } from './events/index.js'", RE)
  })
})
