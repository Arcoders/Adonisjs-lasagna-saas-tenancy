import autocannon from 'autocannon'
import type { BenchResult } from '../src/harness/runner.js'
import { sizes } from '../src/harness/config.js'

const GROUP = 'http'

function fromAutocannon(name: string, r: autocannon.Result): BenchResult {
  const msToNs = (ms: number | undefined) => Math.round((ms ?? 0) * 1e6)
  const reqPerSec = Math.round(r.requests?.average ?? 0)
  return {
    name,
    group: GROUP,
    samples: r.requests?.total ?? 0,
    opsPerSec: reqPerSec, // higher is better — what the regression gate compares
    ns: {
      mean: msToNs(r.latency?.average),
      median: msToNs(r.latency?.p50),
      p75: msToNs((r.latency as any)?.p75 ?? r.latency?.p50),
      p99: msToNs(r.latency?.p99),
      p999: msToNs((r.latency as any)?.p99_9 ?? r.latency?.p99),
      min: msToNs(r.latency?.min),
      max: msToNs(r.latency?.max),
      stddev: msToNs(r.latency?.stddev),
    },
    meta: {
      reqPerSec,
      latencyP50ms: r.latency?.p50,
      latencyP90ms: (r.latency as any)?.p90,
      latencyP99ms: r.latency?.p99,
      latencyMaxms: r.latency?.max,
      non2xx: r.non2xx ?? 0,
      errors: r.errors ?? 0,
      timeouts: r.timeouts ?? 0,
    },
  }
}

/**
 * Run the HTTP scenarios against an already-serving, already-seeded fixture:
 * the tenant-free ceiling, the guarded tenant read (rotating x-tenant-id across
 * seeded tenants), the same read with the guard removed (guard overhead) and
 * with the rate-limit added (Redis pipeline overhead).
 */
export async function runHttpLoad(baseUrl: string, tenantIds: string[]): Promise<BenchResult[]> {
  const connections = sizes.http.connections
  const duration = sizes.http.durationSec

  const rotate = () => {
    let i = 0
    return (req: any) => {
      req.headers = { ...(req.headers ?? {}), 'x-tenant-id': tenantIds[i++ % tenantIds.length] }
      return req
    }
  }

  const scenario = async (name: string, path: string, withTenant: boolean): Promise<BenchResult> => {
    const result = await autocannon({
      url: `${baseUrl}${path}`,
      connections,
      duration,
      ...(withTenant ? { setupRequest: rotate() } : {}),
    } as autocannon.Options)
    return fromAutocannon(name, result as autocannon.Result)
  }

  return [
    await scenario('ceiling (no tenancy)', '/ceiling', false),
    await scenario('tenant read (guarded)', '/tenant/notes', true),
    await scenario('tenant read (no guard)', '/noguard/notes', true),
    await scenario('tenant read (guard + rate-limit)', '/ratelimited/notes', true),
  ]
}
