import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import {
  clamp,
  isNonEmptyString,
  looksLikeUrl,
  isHttpsUrl,
  pickIfDefined,
  parseExpiresAt,
  parseDate,
} from '../../../../src/controllers/pure.js'

/**
 * The pure, container-free helpers shared by the admin controllers. The handler
 * bodies resolve services from the booted container and are exercised by the
 * integration tier, but everything that does not need the container lives in
 * `pure.ts` and is locked here, where a regression is caught with no database
 * and no Ignitor. Several of these guard real attack surface (pagination DOS,
 * SSRF-adjacent URL checks, partial-update clearing semantics), so they are
 * worth precise coverage.
 */

test.group('admin pure — clamp', () => {
  test('returns an in-range integer unchanged, inclusive of the bounds', ({ assert }) => {
    assert.equal(clamp(5, 1, 10, 3), 5)
    assert.equal(clamp(1, 1, 10, 3), 1)
    assert.equal(clamp(10, 1, 10, 3), 10)
  })

  test('clamps below min up and above max down', ({ assert }) => {
    assert.equal(clamp(0, 1, 10, 3), 1)
    assert.equal(clamp(-50, 1, 10, 3), 1)
    assert.equal(clamp(100, 1, 10, 3), 10)
  })

  test('parses a numeric string', ({ assert }) => {
    assert.equal(clamp('7', 1, 10, 3), 7)
  })

  test('truncates fractions toward zero before clamping', ({ assert }) => {
    assert.equal(clamp(5.9, 1, 10, 3), 5)
    assert.equal(clamp(-5.9, 1, 10, 3), 1)
  })

  test('falls back when the value is not a finite number', ({ assert }) => {
    assert.equal(clamp('abc', 1, 10, 3), 3)
    assert.equal(clamp(undefined, 1, 10, 3), 3)
    assert.equal(clamp(Number.NaN, 1, 10, 3), 3)
    assert.equal(clamp(Number.POSITIVE_INFINITY, 1, 10, 3), 3)
  })

  test('treats Number(null) === 0 as a finite value clamped to min', ({ assert }) => {
    assert.equal(clamp(null, 1, 10, 3), 1)
  })
})

test.group('admin pure — isNonEmptyString', () => {
  test('accepts a string with non-whitespace content', ({ assert }) => {
    assert.isTrue(isNonEmptyString('a'))
    assert.isTrue(isNonEmptyString(' x '))
  })

  test('rejects empty and whitespace-only strings', ({ assert }) => {
    assert.isFalse(isNonEmptyString(''))
    assert.isFalse(isNonEmptyString('   '))
  })

  test('rejects non-string values', ({ assert }) => {
    assert.isFalse(isNonEmptyString(123))
    assert.isFalse(isNonEmptyString(null))
    assert.isFalse(isNonEmptyString(undefined))
    assert.isFalse(isNonEmptyString({}))
    assert.isFalse(isNonEmptyString(['a']))
  })
})

test.group('admin pure — looksLikeUrl', () => {
  test('accepts any parseable absolute URL', ({ assert }) => {
    assert.isTrue(looksLikeUrl('https://example.com/logo.png'))
    assert.isTrue(looksLikeUrl('http://example.com'))
    assert.isTrue(looksLikeUrl('ftp://files.example.com/x'))
  })

  test('rejects empty, non-string, and unparseable values', ({ assert }) => {
    assert.isFalse(looksLikeUrl(''))
    assert.isFalse(looksLikeUrl('not a url'))
    assert.isFalse(looksLikeUrl(42))
    assert.isFalse(looksLikeUrl(null))
  })
})

test.group('admin pure — isHttpsUrl', () => {
  test('accepts http and https URLs', ({ assert }) => {
    assert.isTrue(isHttpsUrl('https://app.example.com/callback'))
    assert.isTrue(isHttpsUrl('http://localhost:3000/callback'))
  })

  test('rejects other schemes, non-strings, and garbage', ({ assert }) => {
    assert.isFalse(isHttpsUrl('ftp://example.com'))
    assert.isFalse(isHttpsUrl('javascript:alert(1)'))
    assert.isFalse(isHttpsUrl('example.com'))
    assert.isFalse(isHttpsUrl(123))
  })
})

test.group('admin pure — pickIfDefined', () => {
  test('returns undefined when the field is absent (caller skips it)', ({ assert }) => {
    assert.isUndefined(pickIfDefined({}, 'fromName'))
    assert.isUndefined(pickIfDefined({ other: 1 }, 'fromName'))
    assert.isUndefined(pickIfDefined(null, 'fromName'))
    assert.isUndefined(pickIfDefined(undefined, 'fromName'))
  })

  test('returns null when the field is explicitly null (caller clears it)', ({ assert }) => {
    assert.isNull(pickIfDefined({ logoUrl: null }, 'logoUrl', looksLikeUrl))
  })

  test('returns the value when the validator passes', ({ assert }) => {
    assert.equal(
      pickIfDefined({ logoUrl: 'https://x.test/a.png' }, 'logoUrl', looksLikeUrl),
      'https://x.test/a.png'
    )
  })

  test('returns the value unchanged when no validator is supplied', ({ assert }) => {
    assert.equal(pickIfDefined({ fromName: 'Acme' }, 'fromName'), 'Acme')
  })

  test('throws invalid_<key> when the validator rejects', ({ assert }) => {
    assert.throws(
      () => pickIfDefined({ logoUrl: 'nope' }, 'logoUrl', looksLikeUrl),
      'invalid_logoUrl'
    )
  })
})

test.group('admin pure — parseExpiresAt', () => {
  test('absent/empty/null clears the expiry (ok with null value)', ({ assert }) => {
    assert.deepEqual(parseExpiresAt(undefined), { ok: true, value: null })
    assert.deepEqual(parseExpiresAt(null), { ok: true, value: null })
    assert.deepEqual(parseExpiresAt(''), { ok: true, value: null })
  })

  test('a valid ISO timestamp parses to a DateTime', ({ assert }) => {
    const result = parseExpiresAt('2030-01-01T00:00:00.000Z')
    assert.isTrue(result.ok)
    if (result.ok) {
      assert.instanceOf(result.value, DateTime)
      assert.equal(result.value?.toUTC().toISO(), '2030-01-01T00:00:00.000Z')
    }
  })

  test('a non-string or invalid timestamp is rejected', ({ assert }) => {
    assert.deepEqual(parseExpiresAt(12345), { ok: false })
    assert.deepEqual(parseExpiresAt('not-a-date'), { ok: false })
  })
})

test.group('admin pure — parseDate', () => {
  test('parses a valid ISO date', ({ assert }) => {
    const d = parseDate('2026-06-19T12:00:00.000Z')
    assert.instanceOf(d, Date)
    assert.equal(d?.toISOString(), '2026-06-19T12:00:00.000Z')
  })

  test('returns undefined for absent, empty, non-string, or invalid input', ({ assert }) => {
    assert.isUndefined(parseDate(undefined))
    assert.isUndefined(parseDate(''))
    assert.isUndefined(parseDate(123))
    assert.isUndefined(parseDate('not-a-date'))
  })
})
