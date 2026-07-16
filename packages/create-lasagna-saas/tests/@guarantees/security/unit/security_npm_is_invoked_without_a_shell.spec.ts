import { test } from '@japa/runner'
import { NpmNotFoundError, resolveInvocation, type SpawnEnvironment } from '../../../../src/npm.js'
import { CORE_SPEC, planActions } from '../../../../src/plan.js'

/**
 * Two failures meet on this seam, and fixing either one naively causes the other.
 *
 * Spawning `npm.cmd` without `shell: true` fails with EINVAL on every Node this
 * package supports (the CVE-2024-27980 fix). Setting `shell: true` fixes that and
 * hands the argument vector to cmd.exe, which reads the `>` in the version floor
 * `...@>=0.3.0` as a redirection.
 *
 * The resolution is to run npm's own cli.js under the running Node binary. These
 * specs pin both halves: no `.cmd` is ever spawned, and no argument ever reaches
 * a command interpreter.
 */

const WINDOWS: SpawnEnvironment = {
  platform: 'win32',
  execPath: 'C:\\node\\node.exe',
  npmExecPath: undefined,
  exists: (path) => path.endsWith('npm-cli.js'),
}

const LINUX: SpawnEnvironment = {
  platform: 'linux',
  execPath: '/usr/bin/node',
  npmExecPath: undefined,
  exists: () => false,
}

test.group('Security: npm is invoked without a shell', () => {
  test('on windows npm runs as a script under the running node binary', ({ assert }) => {
    const { file, args } = resolveInvocation('npm', ['install', 'pg'], WINDOWS)

    assert.equal(file, WINDOWS.execPath)
    assert.match(args[0]!, /npm-cli\.js$/)
    assert.deepEqual(args.slice(1), ['install', 'pg'])
  })

  test('on windows a .cmd shim is never spawned', ({ assert }) => {
    const { file, args } = resolveInvocation('npm', ['install'], WINDOWS)

    assert.notInclude(file.toLowerCase(), '.cmd')
    for (const arg of args) assert.notInclude(arg.toLowerCase(), '.cmd')
  })

  test('npm_execpath wins when npm already told us where it lives', ({ assert }) => {
    const env: SpawnEnvironment = {
      ...WINDOWS,
      npmExecPath: 'C:\\somewhere\\npm\\bin\\npm-cli.js',
      exists: () => true,
    }

    assert.equal(resolveInvocation('npm', [], env).args[0], 'C:\\somewhere\\npm\\bin\\npm-cli.js')
  })

  test('a non-js npm_execpath is ignored rather than executed', ({ assert }) => {
    // npm sets this to npm.cmd in some shells. Running it under node would fail.
    const env: SpawnEnvironment = {
      ...WINDOWS,
      npmExecPath: 'C:\\somewhere\\npm.cmd',
    }

    assert.match(resolveInvocation('npm', [], env).args[0]!, /npm-cli\.js$/)
  })

  test('when npm cannot be located it fails loudly instead of guessing', ({ assert }) => {
    const env: SpawnEnvironment = { ...WINDOWS, exists: () => false }

    assert.throws(() => resolveInvocation('npm', [], env), NpmNotFoundError)
  })

  test('elsewhere npm is a shebang script and is spawned directly', ({ assert }) => {
    assert.deepEqual(resolveInvocation('npm', ['install'], LINUX), {
      file: 'npm',
      args: ['install'],
    })
  })

  test('node is never rewritten, on any platform', ({ assert }) => {
    for (const env of [WINDOWS, LINUX]) {
      assert.deepEqual(resolveInvocation('node', ['ace', 'configure'], env), {
        file: 'node',
        args: ['ace', 'configure'],
      })
    }
  })

  test('the version floor survives resolution intact, redirection character and all', ({
    assert,
  }) => {
    // Under `shell: true` cmd.exe would consume `>=0.3.0` as a redirect. It must
    // arrive at npm as one literal argument.
    const install = planActions({ directory: 'app', features: [] }).find(
      (a) => a.kind === 'run' && a.args.includes(CORE_SPEC)
    )
    assert.isDefined(install)

    const { args } = resolveInvocation('npm', install!.kind === 'run' ? install!.args : [], WINDOWS)

    assert.include(args, CORE_SPEC)
    assert.include(CORE_SPEC, '>=')
  })
})
