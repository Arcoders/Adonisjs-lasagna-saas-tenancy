import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * WS-10 / jobs-doc-billing-job-name-mismatch.
 *
 * The billing webhook job is exported as `ProcessBillingEventJob`; the docs used
 * to name the long-renamed `ProcessStripeEventJob`, a class that no longer
 * exists. A documented job name that resolves to no export is a broken reference.
 *
 * RED (pre-fix): jobs.md / events.md / testing.md named `ProcessStripeEventJob`.
 */
const DOC_PAGES = [
  '../../../../../docs/guides/jobs.md',
  '../../../../../docs/reference/events.md',
  '../../../../../docs/guides/testing.md',
].map((p) => fileURLToPath(new URL(p, import.meta.url)))

const BILLING_INDEX = fileURLToPath(new URL('../../../../billing/src/index.ts', import.meta.url))

test.group('architectural — documented job names resolve to real exports', () => {
  test('no doc references the renamed-away ProcessStripeEventJob', ({ assert }) => {
    for (const page of DOC_PAGES) {
      assert.notMatch(
        readFileSync(page, 'utf8'),
        /ProcessStripeEventJob/,
        `${page} names ProcessStripeEventJob (renamed to ProcessBillingEventJob)`
      )
    }
  })

  test('the canonical ProcessBillingEventJob is a real billing export named in jobs.md', ({
    assert,
  }) => {
    assert.match(readFileSync(BILLING_INDEX, 'utf8'), /export\s+\{[^}]*ProcessBillingEventJob/)
    assert.match(readFileSync(DOC_PAGES[0], 'utf8'), /ProcessBillingEventJob/)
  })

  test('detector control: the matcher would catch the dead name', ({ assert }) => {
    assert.match('dispatch ProcessStripeEventJob', /ProcessStripeEventJob/)
    assert.notMatch('dispatch ProcessBillingEventJob', /ProcessStripeEventJob/)
  })
})
