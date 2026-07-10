import { test } from '@japa/runner'
import { parseOptions } from '../../../../src/options.js'

test.group('Behavior: parsing argv', () => {
  test('a bare directory needs no flags', ({ assert }) => {
    assert.deepEqual(parseOptions(['my-saas']), {
      directory: 'my-saas',
      features: [],
      dryRun: false,
    })
  })

  test('--dry-run is order independent', ({ assert }) => {
    assert.isTrue(parseOptions(['--dry-run', 'app']).dryRun)
    assert.isTrue(parseOptions(['app', '--dry-run']).dryRun)
  })

  test('--with splits on commas and trims', ({ assert }) => {
    assert.deepEqual(parseOptions(['app', '--with=webhooks, maintenance']).features, [
      'webhooks',
      'maintenance',
    ])
  })

  test('--with de-duplicates while preserving order', ({ assert }) => {
    assert.deepEqual(parseOptions(['app', '--with=webhooks,maintenance,webhooks']).features, [
      'webhooks',
      'maintenance',
    ])
  })

  test('repeated --with flags accumulate', ({ assert }) => {
    assert.deepEqual(parseOptions(['app', '--with=webhooks', '--with=quotas']).features, [
      'webhooks',
      'quotas',
    ])
  })

  test('a second directory is a mistake, not a silent override', ({ assert }) => {
    assert.throws(() => parseOptions(['one', 'two']), /only one directory/)
  })

  test('an unknown flag is refused rather than forwarded', ({ assert }) => {
    assert.throws(() => parseOptions(['app', '--kit=web']), /unknown flag/)
  })

  test('bundle membership is left to configure, so an unknown-but-well-formed slug passes', ({
    assert,
  }) => {
    assert.deepEqual(parseOptions(['app', '--with=some-future-bundle']).features, [
      'some-future-bundle',
    ])
  })
})
