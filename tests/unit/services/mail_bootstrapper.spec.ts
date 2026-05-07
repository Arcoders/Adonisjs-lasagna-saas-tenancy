import { test } from '@japa/runner'
import {
  createMailBootstrapper,
  TENANT_MAIL_HEADER,
} from '../../../src/services/bootstrappers/mail_bootstrapper.js'

test.group('mailBootstrapper — metadata', () => {
  test('exposes the canonical name and header constant', ({ assert }) => {
    const b = createMailBootstrapper()
    assert.equal(b.name, 'mail')
    assert.equal(TENANT_MAIL_HEADER, 'X-Tenant-Id')
  })
})

test.group('mailBootstrapper — enter rejects unsafe ids', () => {
  test('throws when tenant id has illegal characters in a header value', ({ assert }) => {
    const b = createMailBootstrapper()
    // Header values must be ASCII-printable; CRLF in particular is the
    // classic header-injection vector for outbound mail.
    assert.throws(
      () => b.enter({ tenant: { id: 'a\r\nBcc: attacker@example.com' } as any }),
      /Refusing to use unsafe/
    )
    assert.throws(
      () => b.enter({ tenant: { id: 'a b' } as any }),
      /Refusing to use unsafe/
    )
  })

  test('accepts well-formed tenant ids', ({ assert }) => {
    const b = createMailBootstrapper()
    assert.doesNotThrow(() =>
      b.enter({ tenant: { id: '11111111-1111-4111-8111-111111111111' } as any })
    )
    assert.doesNotThrow(() =>
      b.enter({ tenant: { id: 'plain_tenant_id' } as any })
    )
  })
})
