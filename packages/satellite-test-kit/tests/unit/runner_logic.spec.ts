import { test } from '@japa/runner'
import {
  decideExit,
  deriveSuiteDirectories,
  isConnectionTerminated,
  resolveSpecImport,
  type SummaryLike,
} from '../../src/runner_logic.js'

/**
 * The runner's fragile decision logic, extracted so it is testable without an
 * Ignitor. These are the bits whose silent failure would propagate to every
 * satellite's integration suite: the benign-error filter, the suite-directory
 * derivation, the spec-import classification, and the exit-code recompute
 * (including the zero-tests false-green guard).
 */

const summaryWith = (over: Partial<SummaryLike> = {}): SummaryLike => ({
  hasError: false,
  aggregates: { total: 1 },
  ...over,
})

test.group('isConnectionTerminated', () => {
  test('matches the benign pg teardown race (Error)', ({ assert }) => {
    assert.isTrue(isConnectionTerminated(new Error('Connection terminated unexpectedly')))
  })

  test('matches the benign pg teardown race (string)', ({ assert }) => {
    assert.isTrue(isConnectionTerminated('Connection terminated'))
  })

  test('rejects an unrelated error', ({ assert }) => {
    assert.isFalse(isConnectionTerminated(new Error('relation does not exist')))
  })

  test('rejects a message that only contains the phrase later on', ({ assert }) => {
    assert.isFalse(isConnectionTerminated('pg: Connection terminated'))
  })

  test('handles non-Error, non-string input', ({ assert }) => {
    assert.isFalse(isConnectionTerminated(undefined))
    assert.isFalse(isConnectionTerminated({ message: 'Connection terminated' }))
    assert.isFalse(isConnectionTerminated(42))
  })
})

test.group('deriveSuiteDirectories', () => {
  test('strips the trailing glob to the directory', ({ assert }) => {
    assert.deepEqual(deriveSuiteDirectories(['tests/integration/**/*.spec.ts']), [
      'tests/integration',
    ])
  })

  test('maps every glob independently', ({ assert }) => {
    assert.deepEqual(deriveSuiteDirectories(['a/**/*.spec.ts', 'b/c/**/*.spec.ts']), ['a', 'b/c'])
  })

  test('passes a glob with no /** segment through unchanged', ({ assert }) => {
    assert.deepEqual(deriveSuiteDirectories(['tests/integration']), ['tests/integration'])
  })

  test('falls back to tests/integration when stripping leaves an empty string', ({ assert }) => {
    // A leading-slash glob strips entirely; without the guard this would yield
    // an empty directory and silently match nothing.
    assert.deepEqual(deriveSuiteDirectories(['/**/*.spec.ts']), ['tests/integration'])
  })
})

test.group('resolveSpecImport', () => {
  const fixtureRoot = new URL('file:///app/packages/core/tests/fixtures/')

  test('resolves a ./-relative spec against the fixture root', ({ assert }) => {
    // `./` is relative to the fixtures/ directory itself (the base ends in `/`).
    assert.equal(
      resolveSpecImport('./tests/integration/foo.spec.ts', fixtureRoot),
      'file:///app/packages/core/tests/fixtures/tests/integration/foo.spec.ts'
    )
  })

  test('resolves a ../-relative spec against the fixture root', ({ assert }) => {
    assert.equal(
      resolveSpecImport('../other/bar.spec.ts', fixtureRoot),
      'file:///app/packages/core/tests/other/bar.spec.ts'
    )
  })

  test('returns a bare specifier unchanged', ({ assert }) => {
    assert.equal(resolveSpecImport('@japa/runner', fixtureRoot), '@japa/runner')
  })
})

test.group('decideExit', () => {
  const base = {
    sawNonBenignProcessError: false,
    runnerEnded: true,
    summary: summaryWith() as SummaryLike | undefined,
    currentExitCode: 0,
    allowEmpty: false,
    suiteGlobs: ['tests/integration/**/*.spec.ts'],
    fixtureRoot: 'file:///app/fixture/',
    cwd: '/app/packages/sso',
  }

  test('clean pass downgrades a lingering exit-1 to 0', ({ assert }) => {
    const out = decideExit({ ...base, currentExitCode: 1, summary: summaryWith() })
    assert.deepEqual(out, { code: 0 })
  })

  test('a non-benign process error always fails, even with a passing summary', ({ assert }) => {
    const out = decideExit({
      ...base,
      sawNonBenignProcessError: true,
      summary: summaryWith({ aggregates: { total: 0 } }),
    })
    assert.equal(out.code, 1)
    assert.isUndefined(out.reason)
  })

  test('a test failure preserves japa exit code', ({ assert }) => {
    const out = decideExit({
      ...base,
      currentExitCode: 1,
      summary: summaryWith({ hasError: true }),
    })
    assert.deepEqual(out, { code: 1 })
  })

  test('an early abort (runner never ended) preserves japa exit code', ({ assert }) => {
    const out = decideExit({ ...base, runnerEnded: false, currentExitCode: 1, summary: undefined })
    assert.deepEqual(out, { code: 1 })
  })

  test('an unreadable summary preserves japa exit code', ({ assert }) => {
    const out = decideExit({ ...base, currentExitCode: 7, summary: undefined })
    assert.deepEqual(out, { code: 7 })
  })

  test('zero tests fails loud with a diagnostic reason', ({ assert }) => {
    const out = decideExit({
      ...base,
      currentExitCode: 0,
      summary: summaryWith({ aggregates: { total: 0 } }),
    })
    assert.equal(out.code, 1)
    assert.match(out.reason ?? '', /0 tests ran/)
    assert.match(out.reason ?? '', /tests\/integration\/\*\*\/\*\.spec\.ts/)
    assert.match(out.reason ?? '', /\/app\/packages\/sso/)
    assert.match(out.reason ?? '', /allowEmpty:true/)
  })

  test('allowEmpty lets a zero-test run pass', ({ assert }) => {
    const out = decideExit({
      ...base,
      allowEmpty: true,
      summary: summaryWith({ aggregates: { total: 0 } }),
    })
    assert.deepEqual(out, { code: 0 })
  })
})
