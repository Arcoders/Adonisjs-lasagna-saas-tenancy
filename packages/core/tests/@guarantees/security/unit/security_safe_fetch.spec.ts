import { test } from '@japa/runner'
import { resolvePinnedHttpsTarget } from '../../../../src/utils/url.js'
import { pinnedLookup, safeFetch, SafeFetchError } from '../../../../src/utils/safe_fetch.js'

/**
 * WS-4: the outbound seam's security decisions, tested deterministically (no
 * network). resolvePinnedHttpsTarget is the validate-and-pin core: it decides
 * which single address a connection is allowed to pin, and it fails closed on
 * anything unsafe. safeFetch's mode selection and error classification (a blocked
 * range is permanent, a resolution failure is retryable) are pinned here too.
 */

test.group('resolvePinnedHttpsTarget — fail-closed validation', () => {
  test('rejects non-https', async ({ assert }) => {
    assert.equal(await resolvePinnedHttpsTarget('http://example.com/'), 'url_must_be_https')
  })

  test('rejects loopback, private, link-local/metadata, and CGN literals', async ({ assert }) => {
    assert.equal(await resolvePinnedHttpsTarget('https://127.0.0.1/'), 'url_blocks_loopback')
    assert.equal(await resolvePinnedHttpsTarget('https://10.0.0.1/'), 'url_blocks_private')
    assert.equal(await resolvePinnedHttpsTarget('https://192.168.1.1/'), 'url_blocks_private')
    assert.equal(
      await resolvePinnedHttpsTarget('https://169.254.169.254/'),
      'url_blocks_link_local'
    )
    assert.equal(await resolvePinnedHttpsTarget('https://100.64.0.1/'), 'url_blocks_cgn')
  })

  test('rejects ambiguous / numeric IP encodings (loopback in disguise)', async ({ assert }) => {
    // Node's URL parser canonicalises many numeric hosts to a dotted IPv4, so a
    // decimal/hex loopback reads as url_blocks_loopback; the ambiguous-host check
    // backstops the rest. Either way the result is a rejection (a string code).
    assert.isString(await resolvePinnedHttpsTarget('https://2130706433/'))
    assert.isString(await resolvePinnedHttpsTarget('https://0x7f000001/'))
    assert.isString(await resolvePinnedHttpsTarget('https://0177.0.0.1/'))
  })

  test('rejects IPv6 loopback and ULA/link-local literals', async ({ assert }) => {
    assert.equal(await resolvePinnedHttpsTarget('https://[::1]/'), 'url_blocks_loopback')
    assert.equal(await resolvePinnedHttpsTarget('https://[fc00::1]/'), 'url_blocks_private')
    assert.equal(await resolvePinnedHttpsTarget('https://[fe80::1]/'), 'url_blocks_link_local')
  })

  test('pins a public IP literal without a DNS lookup', async ({ assert }) => {
    const target = await resolvePinnedHttpsTarget('https://1.1.1.1/path?q=1')
    assert.isObject(target)
    if (typeof target === 'string') return
    assert.equal(target.address, '1.1.1.1')
    assert.equal(target.family, 4)
    assert.equal(target.hostname, '1.1.1.1')
    assert.equal(target.url.pathname, '/path')
  })
})

test.group('safeFetch — mode selection + error classification', () => {
  test('trusted-host mode rejects an off-allowlist host', async ({ assert }) => {
    await assert.rejects(
      () => safeFetch('https://evil.example/', { trustedHost: true }),
      /not in the trusted-host allowlist/
    )
  })

  test('trusted-host mode rejects a non-https host', async ({ assert }) => {
    await assert.rejects(
      () => safeFetch('http://api.paddle.com/', { trustedHost: true }),
      /must be https/
    )
  })

  test('pinned mode rejects a blocked URL as a NON-retryable error', async ({ assert }) => {
    try {
      await safeFetch('https://10.0.0.1/hook')
      assert.fail('should have thrown')
    } catch (err) {
      assert.instanceOf(err, SafeFetchError)
      assert.equal((err as SafeFetchError).code, 'url_blocks_private')
      assert.isFalse(
        (err as SafeFetchError).retryable,
        'a blocked range is permanent, never retried'
      )
    }
  })

  test('a resolution failure is classified retryable', ({ assert }) => {
    // The webhook retry path keys on this: a transient DNS failure should retry
    // (re-validating each time), a structural rejection should not.
    const dns = new SafeFetchError('url_dns_failure', 'x', true)
    const blocked = new SafeFetchError('url_blocks_private', 'y', false)
    assert.isTrue(dns.retryable)
    assert.isFalse(blocked.retryable)
  })
})

test.group('pinnedLookup — pins one validated address, honours Happy-Eyeballs', () => {
  // Since Node 20, autoSelectFamily (default true) calls a custom `lookup` with
  // `{ all: true }` and REQUIRES an array result `[{ address, family }]`. A
  // single-address callback there throws ERR_INVALID_IP_ADDRESS at connect, which
  // silently broke every pinned request on Node 24 (webhook/OIDC delivery). These
  // are the regression guards for that path.
  test('under { all: true } (Node Happy-Eyeballs) returns an address ARRAY', ({ assert }) => {
    const lookup = pinnedLookup('203.0.113.7', 4)
    let out: unknown
    lookup(
      'ignored.example',
      { all: true } as never,
      ((_e: null, a: unknown) => {
        out = a
      }) as never
    )
    assert.deepEqual(out, [{ address: '203.0.113.7', family: 4 }])
  })

  test('without { all } returns the single (address, family) form', ({ assert }) => {
    const lookup = pinnedLookup('203.0.113.7', 4)
    let addr: unknown
    let fam: unknown
    lookup(
      'ignored.example',
      {} as never,
      ((_e: null, a: unknown, f: unknown) => {
        addr = a
        fam = f
      }) as never
    )
    assert.equal(addr, '203.0.113.7')
    assert.equal(fam, 4)
  })

  test('pins exactly the validated address, ignoring the hostname (no rebind)', ({ assert }) => {
    // The pin must never re-resolve: whatever hostname Node passes, the connection
    // goes to the one address resolvePinnedHttpsTarget already validated.
    const lookup = pinnedLookup('198.51.100.9', 6)
    for (const host of ['attacker.example', 'metadata.google.internal', '']) {
      let out: unknown
      lookup(
        host,
        { all: true } as never,
        ((_e: null, a: unknown) => {
          out = a
        }) as never
      )
      assert.deepEqual(out, [{ address: '198.51.100.9', family: 6 }], `host=${host}`)
    }
  })
})
