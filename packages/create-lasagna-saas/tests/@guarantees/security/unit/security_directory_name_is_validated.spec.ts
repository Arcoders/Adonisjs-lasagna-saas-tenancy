import { test } from '@japa/runner'
import { InvalidOptionError, parseOptions } from '../../../../src/options.js'

/**
 * The destination directory is the one argument that reaches another program.
 * It is spawned as argv without a shell, so there is no command injection to
 * defend against, but two shapes still do damage:
 *
 *   - a leading dash is read by create-adonisjs as a flag, not a destination
 *   - a traversal or absolute path scaffolds the app outside the current directory
 *
 * Both are rejected before the first process is spawned.
 */

const REJECTED = [
  { name: 'a leading dash reads as a flag', value: '-rf' },
  { name: 'a long flag reads as a flag', value: '--force' },
  { name: 'parent traversal escapes the cwd', value: '../elsewhere' },
  { name: 'a nested traversal escapes the cwd', value: 'app/../../elsewhere' },
  { name: 'a posix absolute path escapes the cwd', value: '/tmp/app' },
  { name: 'a nested path is more than one segment', value: 'apps/api' },
  { name: 'a backslash path escapes on windows', value: '..\\elsewhere' },
  { name: 'the empty string names nothing', value: '' },
  { name: 'a bare dot is not a name', value: '.' },
  { name: 'a shell metacharacter has no business here', value: 'app;rm' },
  { name: 'a spaced name has no business here', value: 'my app' },
]

test.group('Security: the target directory is validated', () => {
  for (const { name, value } of REJECTED) {
    test(`rejects ${name}: ${JSON.stringify(value)}`, ({ assert }) => {
      assert.throws(() => parseOptions([value]), InvalidOptionError)
    })
  }

  test('rejects a missing directory rather than defaulting to the cwd', ({ assert }) => {
    assert.throws(() => parseOptions([]), InvalidOptionError)
    assert.throws(() => parseOptions(['--dry-run']), InvalidOptionError)
  })

  test('accepts ordinary single-segment names', ({ assert }) => {
    for (const value of ['app', 'my-saas', 'my_saas', 'saas.v2', 'App2']) {
      assert.equal(parseOptions([value]).directory, value)
    }
  })

  test('rejects a feature bundle that is not a plain slug', ({ assert }) => {
    for (const value of ['--with=web hooks', '--with=-webhooks', '--with=', '--with=a,,b']) {
      assert.throws(() => parseOptions(['app', value]), InvalidOptionError)
    }
  })
})
