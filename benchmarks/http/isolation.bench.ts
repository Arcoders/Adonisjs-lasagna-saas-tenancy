/**
 * Isolation tier — the assertion the throughput HTTP tier does NOT make.
 *
 * Fires many concurrent requests, each rotating `x-tenant-id` across the seeded
 * tenants, and asserts per response that it carries ONLY the requested tenant's
 * data — exercising the real request path (header → resolver → TenantAdapter →
 * AsyncLocalStorage → driver → pool) under concurrency. A single mismatch is a
 * cross-tenant leak and fails the gate.
 *
 * The seeded note titles encode their owner (`t:<id>:<i>`) so any row in the
 * `id desc limit 20` window proves ownership; see `seedIdentifiableNotes`.
 */
import { runConcurrent, percentileNs } from '../src/harness/concurrent_client.js'
import { zeroMetric, type BenchResult } from '../src/harness/runner.js'
import { identifiableTitlePrefix } from '../src/harness/provision.js'
import { sizes } from '../src/harness/config.js'

const GROUP = 'isolation'
const HEADER = process.env.TENANT_HEADER_KEY ?? 'x-tenant-id'

interface NotesBody {
  tenantId?: string
  notes?: Array<{ id?: number; title?: string }>
}

export async function runIsolationLoad(baseUrl: string, tenantIds: string[]): Promise<BenchResult[]> {
  const { requests, concurrency, selftest, maxErrorRate } = sizes.iso
  const results: BenchResult[] = []

  const scenario = async (name: string, path: string): Promise<BenchResult> => {
    const r = await runConcurrent({
      baseUrl,
      workers: concurrency,
      totalRequests: requests,
      pickRequest: (i) => {
        const sent = tenantIds[i % tenantIds.length]
        // Self-test: claim a DIFFERENT tenant than the one we send, so the
        // content check is guaranteed to fail. Proves the assertion detects a
        // leak rather than rubber-stamping every run.
        const expected = selftest ? tenantIds[(i + 1) % tenantIds.length] : sent
        return { path, headers: { [HEADER]: sent }, meta: { expected } }
      },
      check: (req, status, body) => {
        const expected = String(req.meta?.expected)
        // A non-200 is an availability failure (pool pressure, transient 5xx),
        // not a cross-tenant leak. Flag it as `error` so it is counted as a
        // transport error, never as a mismatch that would fail the isolation gate.
        if (status !== 200)
          return { ok: false, error: true, reason: `status ${status} (expected tenant ${expected})` }
        const b = body as NotesBody
        if (b?.tenantId !== expected) {
          return { ok: false, reason: `echoed tenantId ${b?.tenantId} != ${expected}` }
        }
        const prefix = identifiableTitlePrefix(expected)
        for (const note of b.notes ?? []) {
          if (!String(note.title ?? '').startsWith(prefix)) {
            return { ok: false, reason: `note "${note.title}" not owned by ${expected}` }
          }
        }
        return { ok: true }
      },
    })

    const leaks = r.mismatches
    // The isolation check only inspects 200s, so a run that mostly errors could
    // read PASS vacuously. The error-rate ceiling makes that a FAIL in its own
    // right — and because bench:check fails the PR on any `*Check=FAIL`, a
    // degraded persisted run can't slip through the correctness gate either.
    const errorRate = r.total === 0 ? 1 : r.errors / r.total
    return zeroMetric(
      name,
      {
        requests: r.total,
        concurrency,
        ok: r.ok,
        crossTenantResponses: leaks,
        transportErrors: r.errors,
        errorRatePct: Math.round(errorRate * 10_000) / 100,
        p99Ms: Math.round(percentileNs(r.latencyNs, 99) / 1e5) / 10,
        isolationCheck: leaks === 0 ? 'PASS' : 'FAIL',
        errorRateCheck: errorRate <= maxErrorRate ? 'PASS' : 'FAIL',
        sample: r.sampleMismatches.slice(0, 3).join(' | '),
        errorSample: r.sampleErrors.slice(0, 3).join(' | '),
      },
      GROUP
    )
  }

  results.push(await scenario('guarded tenant read', '/tenant/notes'))
  results.push(await scenario('unguarded tenant read', '/noguard/notes'))
  return results
}
