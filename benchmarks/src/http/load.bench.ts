import autocannon from 'autocannon'
import type { BenchResult } from '../harness/runner.js'
import { sizes } from '../harness/config.js'

const GROUP = 'http'

function fromAutocannon(name: string, r: autocannon.Result): BenchResult {
  const msToNs = (ms: number | undefined) => Math.round((ms ?? 0) * 1e6)
  const reqPerSec = Math.round(r.requests?.average ?? 0)
  return {
    name,
    group: GROUP,
    samples: r.requests?.total ?? 0,
    opsPerSec: reqPerSec, // higher is better, what the regression gate compares
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

  // autocannon only re-renders a header per request if that header key already
  // exists in the top-level `headers`. Otherwise it pre-renders the request
  // bytes once. So we seed a placeholder `x-tenant-id` in `headers` and have
  // setupRequest *mutate that existing key's value* per request. Spreading a
  // fresh `req.headers` (or relying on setupRequest alone, with no placeholder)
  // silently drops the header and every tenant request 400s with
  // E_MISSING_TENANT_HEADER.
  const rotate = () => {
    let i = 0
    return (req: any) => {
      req.headers['x-tenant-id'] = tenantIds[i++ % tenantIds.length]
      return req
    }
  }

  const scenario = async (
    name: string,
    path: string,
    withTenant: boolean
  ): Promise<BenchResult> => {
    const result = await autocannon({
      url: `${baseUrl}${path}`,
      connections,
      duration,
      ...(withTenant ? { headers: { 'x-tenant-id': tenantIds[0] }, setupRequest: rotate() } : {}),
    } as autocannon.Options)
    return fromAutocannon(name, result as autocannon.Result)
  }

  const results = [
    await scenario('ceiling (no tenancy)', '/ceiling', false),
    await scenario('tenant read (guarded)', '/tenant/notes', true),
    await scenario('tenant read (no guard)', '/noguard/notes', true),
    await scenario('tenant read (guard + rate-limit)', '/ratelimited/notes', true),
  ]

  // Fail loudly if a scenario was essentially all error responses. A mostly-non-2xx
  // run measures the rate of 500s, not tenant reads (e.g. tenant connections not
  // registered in the serving process). Never write that out as a throughput number.
  for (const r of results) {
    const non2xx = Number(r.meta?.non2xx ?? 0)
    if (r.samples > 0 && non2xx / r.samples > 0.05) {
      throw new Error(
        `HTTP scenario "${r.name}": ${non2xx}/${r.samples} non-2xx — tenant routing is ` +
          `broken in the serve process; numbers are invalid. Did the warm-up run?`
      )
    }
  }

  return results
}
