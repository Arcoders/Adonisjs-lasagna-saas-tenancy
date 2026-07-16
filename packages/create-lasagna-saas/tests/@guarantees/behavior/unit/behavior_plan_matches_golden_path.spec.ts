import { test } from '@japa/runner'
import {
  CORE_MINIMUM,
  CORE_PACKAGE,
  CORE_SPEC,
  planActions,
  nextSteps,
} from '../../../../src/plan.js'

/**
 * The plan mirrors `scripts/clean-install-smoke.sh`, the one sequence CI proves
 * works against a packed tarball on a clean machine. These specs pin the parts
 * of that order which are load bearing: the peers must be configured before
 * core's `configure` runs, and `config/database.ts` must be written after it,
 * because `configure` is what creates the app the file configures.
 */

function titles(actions: ReturnType<typeof planActions>): string[] {
  return actions.map((a) => a.title)
}

test.group('Behavior: the plan follows the verified golden path', () => {
  test('the app is scaffolded before anything is installed into it', ({ assert }) => {
    const actions = planActions({ directory: 'app', features: [] })
    const scaffold = actions.findIndex(
      (a) => a.kind === 'run' && a.args.includes('adonisjs@latest')
    )
    const install = actions.findIndex((a) => a.kind === 'run' && a.args.includes(CORE_SPEC))

    assert.equal(scaffold, 0)
    assert.isAbove(install, scaffold)
  })

  test('core is installed with a floor, never unpinned', ({ assert }) => {
    // Any core below 0.3.0 has a configure hook that is a silent no-op: it warns,
    // exits 0, and publishes nothing. Resolving one would hand the user a broken
    // app with no error. The floor makes npm refuse the install instead.
    const actions = planActions({ directory: 'app', features: [] })
    const install = actions.find((a) => a.kind === 'run' && a.args.includes('install'))
    const args = install?.kind === 'run' ? install.args : []

    assert.notInclude(args, CORE_PACKAGE, 'core must not be installed unpinned')
    assert.include(args, `${CORE_PACKAGE}@>=${CORE_MINIMUM}`)
    assert.isAtLeast(Number(CORE_MINIMUM.split('.')[1]), 3, 'the floor must exclude 0.2.x')
  })

  test('only the scaffold step runs outside the new directory', ({ assert }) => {
    const actions = planActions({ directory: 'app', features: [] })
    const outside = actions.filter((a) => a.kind === 'run' && a.cwd === 'parent')

    assert.lengthOf(outside, 1)
    assert.include(outside[0]!.title, 'Scaffolding')
  })

  test('redis and queue are configured before core', ({ assert }) => {
    const names = titles(planActions({ directory: 'app', features: [] }))
    const redis = names.findIndex((t) => t.includes('@adonisjs/redis'))
    const queue = names.findIndex((t) => t.includes('@adonisjs/queue'))
    const core = names.findIndex((t) => t.includes(CORE_PACKAGE))

    assert.isAbove(core, redis)
    assert.isAbove(core, queue)
  })

  test('config/database.ts is written after configure, never before', ({ assert }) => {
    const actions = planActions({ directory: 'app', features: [] })
    const core = actions.findIndex(
      (a) => a.kind === 'run' && a.command === 'node' && a.args.includes(CORE_PACKAGE)
    )
    const database = actions.findIndex((a) => a.kind === 'write' && a.path === 'config/database.ts')

    assert.isAbove(core, 0)
    assert.isAbove(database, core)
  })

  test('the queue configure feeds a newline, because it prompts for a driver', ({ assert }) => {
    const actions = planActions({ directory: 'app', features: [] })
    const queue = actions.find((a) => a.kind === 'run' && a.title.includes('@adonisjs/queue'))

    assert.equal(queue?.kind === 'run' ? queue.stdin : undefined, '\n')
  })

  test('no --with flag is passed when no features are requested', ({ assert }) => {
    const actions = planActions({ directory: 'app', features: [] })
    const core = actions.find((a) => a.kind === 'run' && a.args.includes(CORE_PACKAGE))

    assert.isFalse(core?.kind === 'run' && core.args.some((arg) => arg.startsWith('--with')))
  })

  test('requested features become a single --with flag', ({ assert }) => {
    const actions = planActions({ directory: 'app', features: ['webhooks', 'maintenance'] })
    const configure = actions.find(
      (a) => a.kind === 'run' && a.command === 'node' && a.args.includes(CORE_PACKAGE)
    )

    assert.deepEqual(configure?.kind === 'run' ? configure.args : [], [
      'ace',
      'configure',
      CORE_PACKAGE,
      '--with=webhooks,maintenance',
    ])
  })

  test('nothing in the plan touches a database', ({ assert }) => {
    const actions = planActions({ directory: 'app', features: ['webhooks'] })
    const commands = actions
      .filter((a) => a.kind === 'run')
      .map((a) => [a.command, ...a.args].join(' '))

    for (const command of commands) {
      assert.notInclude(command, 'backoffice:setup')
      assert.notInclude(command, 'tenant:create')
      assert.notInclude(command, 'migration:run')
    }
  })

  test('the database steps are handed to the operator instead', ({ assert }) => {
    const steps = nextSteps({ directory: 'app', databaseName: 'app' }).join('\n')

    assert.include(steps, 'backoffice:setup')
    assert.include(steps, 'tenant:create')
    assert.include(steps, 'queue:work')
  })
})
