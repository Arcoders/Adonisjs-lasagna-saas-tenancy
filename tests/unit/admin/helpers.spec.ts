import { test } from '@japa/runner'
import { validateExternalHttpsUrl } from '../../../src/admin/controllers/helpers.js'

/**
 * SSRF guard. The function returns `null` when the URL is safe to fetch from
 * a server-side context, or a stable error code otherwise. The admin
 * controllers (webhooks, SSO) and SsoService.discover() all gate
 * server-side fetches through this — every production-relevant rejection
 * path needs explicit coverage.
 */
test.group('validateExternalHttpsUrl — SSRF guard', () => {
  test('accepts a typical external https URL', ({ assert }) => {
    assert.isNull(validateExternalHttpsUrl('https://login.acme.example/oauth'))
    assert.isNull(validateExternalHttpsUrl('https://idp.example.com/.well-known/openid-configuration'))
    assert.isNull(validateExternalHttpsUrl('https://api.stripe.com/v1/charges'))
  })

  test('rejects empty / non-string input', ({ assert }) => {
    assert.equal(validateExternalHttpsUrl(undefined), 'url_required')
    assert.equal(validateExternalHttpsUrl(null), 'url_required')
    assert.equal(validateExternalHttpsUrl(''), 'url_required')
    assert.equal(validateExternalHttpsUrl(42), 'url_required')
    assert.equal(validateExternalHttpsUrl({}), 'url_required')
  })

  test('rejects malformed URLs', ({ assert }) => {
    assert.equal(validateExternalHttpsUrl('not a url'), 'url_invalid')
    assert.equal(validateExternalHttpsUrl('javascript:alert(1)'), 'url_must_be_https')
  })

  test('rejects non-https schemes', ({ assert }) => {
    assert.equal(validateExternalHttpsUrl('http://example.com'), 'url_must_be_https')
    assert.equal(validateExternalHttpsUrl('ftp://example.com'), 'url_must_be_https')
    assert.equal(validateExternalHttpsUrl('file:///etc/passwd'), 'url_must_be_https')
    assert.equal(validateExternalHttpsUrl('gopher://example.com'), 'url_must_be_https')
    assert.equal(validateExternalHttpsUrl('data:text/plain,hello'), 'url_must_be_https')
  })

  test('rejects IPv4 loopback', ({ assert }) => {
    assert.equal(validateExternalHttpsUrl('https://127.0.0.1/'), 'url_blocks_loopback')
    assert.equal(validateExternalHttpsUrl('https://127.5.5.5/'), 'url_blocks_loopback')
    assert.equal(validateExternalHttpsUrl('https://localhost/'), 'url_blocks_loopback')
    assert.equal(validateExternalHttpsUrl('https://0.0.0.0/'), 'url_blocks_loopback')
  })

  test('rejects RFC 1918 private ranges', ({ assert }) => {
    assert.equal(validateExternalHttpsUrl('https://10.0.0.1/'), 'url_blocks_private')
    assert.equal(validateExternalHttpsUrl('https://172.16.0.1/'), 'url_blocks_private')
    assert.equal(validateExternalHttpsUrl('https://172.31.255.255/'), 'url_blocks_private')
    assert.equal(validateExternalHttpsUrl('https://192.168.1.1/'), 'url_blocks_private')
  })

  test('rejects link-local 169.254.0.0/16 (covers AWS/DO/Azure metadata)', ({ assert }) => {
    assert.equal(validateExternalHttpsUrl('https://169.254.169.254/'), 'url_blocks_link_local')
    assert.equal(validateExternalHttpsUrl('https://169.254.1.1/'), 'url_blocks_link_local')
  })

  test('rejects GCP metadata hostnames by name (defeats DNS-rebinding)', ({ assert }) => {
    assert.equal(validateExternalHttpsUrl('https://metadata.google.internal/'), 'url_blocks_metadata')
    assert.equal(validateExternalHttpsUrl('https://metadata/'), 'url_blocks_metadata')
  })

  test('rejects CGN range 100.64.0.0/10', ({ assert }) => {
    assert.equal(validateExternalHttpsUrl('https://100.64.0.1/'), 'url_blocks_cgn')
    assert.equal(validateExternalHttpsUrl('https://100.127.255.255/'), 'url_blocks_cgn')
  })

  test('rejects 0.0.0.0/8 reserved', ({ assert }) => {
    assert.equal(validateExternalHttpsUrl('https://0.1.2.3/'), 'url_blocks_reserved')
  })

  test('rejects IPv4 octets out of range (URL parser throws first → url_invalid)', ({
    assert,
  }) => {
    // Modern Node URL parser rejects out-of-range octets at parse time, so
    // the `url_invalid_ipv4` branch fires only on engines that still accept
    // them. Either rejection is acceptable for our threat model — what
    // matters is that nothing in this shape ever returns `null`.
    assert.isNotNull(validateExternalHttpsUrl('https://999.0.0.1/'))
    assert.isNotNull(validateExternalHttpsUrl('https://256.256.256.256/'))
  })

  test('rejects IPv6 loopback / ULA / link-local / unspecified', ({ assert }) => {
    assert.equal(validateExternalHttpsUrl('https://[::1]/'), 'url_blocks_loopback')
    assert.equal(validateExternalHttpsUrl('https://[fc00::1]/'), 'url_blocks_private')
    assert.equal(validateExternalHttpsUrl('https://[fd12:3456::1]/'), 'url_blocks_private')
    assert.equal(validateExternalHttpsUrl('https://[fe80::1]/'), 'url_blocks_link_local')
    assert.equal(validateExternalHttpsUrl('https://[::]/'), 'url_blocks_reserved')
  })

  test('accepts public IPv4', ({ assert }) => {
    assert.isNull(validateExternalHttpsUrl('https://8.8.8.8/'))
    assert.isNull(validateExternalHttpsUrl('https://1.1.1.1/'))
  })

  test('accepts URLs with paths, queries, and ports', ({ assert }) => {
    assert.isNull(
      validateExternalHttpsUrl('https://idp.example.com:8443/oauth/authorize?foo=1#x')
    )
  })
})
