import {
  TenantResolverRegistry,
  HeaderResolver,
  SubdomainResolver,
  PathResolver,
  DomainOrSubdomainResolver,
  RequestDataResolver,
} from './internal.js'
import { runMicro, type BenchResult } from '../harness/runner.js'
import { fakeRequest } from './fake_request.js'

const GROUP = 'tenant_resolution'

function registry(names: string[]): TenantResolverRegistry {
  const r = new TenantResolverRegistry()
  r.register(new HeaderResolver())
    .register(new SubdomainResolver())
    .register(new PathResolver())
    .register(new DomainOrSubdomainResolver())
    .register(new RequestDataResolver())
  r.setChain(names)
  return r
}

/**
 * Prices the synchronous resolver chain walk `TenantAdapter` runs on every
 * query. Covers a first-resolver hit at chain depth 1/3, a fall-through to a
 * later resolver, and a full miss across the 5-resolver chain.
 */
export function runTenantResolution(): BenchResult[] {
  const withHeader = fakeRequest({
    headers: { 'x-tenant-id': '11111111-1111-4111-8111-111111111111' },
  })
  const subdomainOnly = fakeRequest({ hostname: 'acme.localhost' })
  const pathOnly = fakeRequest({ hostname: 'localhost', url: '/acme/resource' })
  const miss = fakeRequest({ hostname: 'localhost', url: '/', qs: {} })

  const chain1 = registry(['header'])
  const chain3 = registry(['header', 'subdomain', 'path'])
  const chain5 = registry(['header', 'subdomain', 'path', 'domain-or-subdomain', 'request-data'])
  const fallthrough = registry(['header', 'subdomain', 'path'])

  return [
    runMicro('header hit (chain=1)', () => chain1.resolveSync(withHeader), { group: GROUP }),
    runMicro('header hit (chain=3)', () => chain3.resolveSync(withHeader), { group: GROUP }),
    runMicro('subdomain hit (chain=3, header miss)', () => chain3.resolveSync(subdomainOnly), {
      group: GROUP,
    }),
    runMicro('path hit (fall-through to 3rd)', () => fallthrough.resolveSync(pathOnly), {
      group: GROUP,
    }),
    runMicro('full miss (chain=5)', () => chain5.resolveSync(miss), { group: GROUP }),
  ]
}
