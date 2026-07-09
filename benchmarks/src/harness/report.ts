/**
 * `npm run bench:report` — aggregate the newest result per suite/driver into
 * the generated docs page (docs/guides/performance.md) and, with
 * `--write-baseline=<name>`, snapshot a flat baseline index for the gate.
 *
 * Run on the canonical reference box for the 1.0.0 numbers:
 *   npm run bench:report -- --write-baseline=1.0.0
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import {
  latestBySuiteDriver,
  latestNBySuiteDriver,
  median,
  iqr,
  type ResultFile,
} from './results.js'
import type { BenchResult } from './runner.js'

const PERF_DOC = new URL('../../../docs/guides/performance.md', import.meta.url)
const SCALING_DOC = new URL('../../../docs/guides/scaling-limits.md', import.meta.url)
const BASELINES_DIR = new URL('../../baselines/', import.meta.url)
const INJECT_START = '<!-- BENCH:summary:start -->'
const INJECT_END = '<!-- BENCH:summary:end -->'

interface FlatEntry {
  key: string // "<suite>:<driver>"
  label: string // "<group › name>" or "<name>"
  opsPerSec: number
  nsMedian: number
  nsP99: number
}

function flatLabel(r: BenchResult): string {
  return r.group ? `${r.group} › ${r.name}` : r.name
}

function flatten(file: ResultFile): FlatEntry[] {
  const key = `${file.suite}:${file.env.driver}`
  return file.results.map((r) => ({
    key,
    label: flatLabel(r),
    opsPerSec: Math.round(r.opsPerSec),
    nsMedian: Math.round(r.ns.median),
    nsP99: Math.round(r.ns.p99),
  }))
}

function mdTable(file: ResultFile): string {
  const lines = [
    `| metric | ops/sec | median (ns) | p99 (ns) |`,
    `|---|--:|--:|--:|`,
    ...file.results.map(
      (r) =>
        `| ${flatLabel(r)} | ${Math.round(r.opsPerSec).toLocaleString()} | ` +
        `${Math.round(r.ns.median).toLocaleString()} | ${Math.round(r.ns.p99).toLocaleString()} |`
    ),
  ]
  return lines.join('\n')
}

/** Metric-only suites (e.g. memory/catalog) carry their value in `meta`. */
function mdMetaTable(file: ResultFile): string {
  const keys = [...new Set(file.results.flatMap((r) => Object.keys(r.meta ?? {})))]
  const header = `| metric | ${keys.join(' | ')} |`
  const sep = `|---|${keys.map(() => '--:').join('|')}|`
  const rows = file.results.map((r) => {
    const cells = keys.map((k) => String((r.meta ?? {})[k] ?? ''))
    return `| ${flatLabel(r)} | ${cells.join(' | ')} |`
  })
  return [header, sep, ...rows].join('\n')
}

function sectionTable(file: ResultFile): string {
  const metricOnly = file.results.length > 0 && file.results.every((r) => r.opsPerSec === 0)
  return metricOnly ? mdMetaTable(file) : mdTable(file)
}

/** Largest value seen for a meta key across a suite's rows (0 if absent). */
function maxMeta(
  latest: Map<string, ResultFile>,
  suite: string,
  group: string,
  key: string
): number {
  let max = 0
  for (const file of latest.values()) {
    if (file.suite !== suite) continue
    for (const r of file.results) {
      if (r.group !== group) continue
      const n = Number((r.meta ?? {})[key])
      if (Number.isFinite(n)) max = Math.max(max, n)
    }
  }
  return max
}

/**
 * Honest reading guidance, baked into the generated page so the numbers are
 * never quoted out of context. The durable note always prints; the provisional
 * warning prints only when the run did NOT come from the Linux reference box
 * (i.e. a dev-box Windows/macOS + Docker Desktop snapshot), where absolute
 * throughput is materially understated. The canonical Linux capture drops it.
 *
 * The "smoke sizes" clause is data-driven: it appears only while the heavy
 * tiers are actually small, and disappears once a full sweep is present — so a
 * full-size dev-box run still flags Docker inflation but stops claiming the
 * curves are smoke-sized.
 */
function caveat(env: ResultFile['env'] | undefined, latest: Map<string, ResultFile>): string[] {
  const lines = [
    '> ## ⚙️ Operational must-knows (read before sizing)',
    '>',
    '> 1. **Open connections scale with *active tenants*, not `maxTenantConnections`.**',
    '>    The in-use-aware LRU never severs an in-flight connection, so under the',
    '>    default 30s grace a burst of N concurrently-active tenants opens ~N',
    '>    connections (see the connection-budget burst tier). The real ceiling is',
    '>    Postgres `max_connections` — **size it (and front with PgBouncer transaction',
    '>    pooling at higher tenant counts) for your peak concurrent-tenant count**,',
    '>    not for `maxTenantConnections`.',
    '> 2. **The first query for an idle tenant pays a ~9ms cold-connection cliff**',
    '>    (register connection + pool + `SET search_path`). Keep hot tenants warm:',
    '>    set `maxTenantConnections` above your steady concurrent-tenant count and',
    '>    `evictionGracePeriodMs` above your p99 request latency.',
    '> 3. **Every tenant request makes a backoffice lookup by default.** The guard',
    '>    resolves the tenant from the central DB on each request — a second round',
    '>    trip on the hot path. Enable `resolver.cache` to serve warm tenants from a',
    '>    per-pod cache, cutting the steady-state backoffice round-trips per request',
    '>    from two to one. Staleness is bounded by the TTL (default 10s): a status',
    '>    change propagates across pods within `ttlMs`, and the in-process fast-path',
    '>    invalidation fires only when the matching lifecycle event is emitted (the',
    '>    admin package does this; if you suspend tenants another way, emit',
    '>    `TenantSuspended` yourself or rely on the TTL). The cached tenant is the',
    '>    SAME instance for every concurrent request in the pod — treat it as',
    '>    read-only and load a fresh instance for any mutate-then-save flow.',
    '',
    '> **Read the shape, not the absolutes.** The durable signal here is the',
    '> *relative* cost across drivers and code paths — header resolution is far',
    '> cheaper than subdomain/path; rowscope-pg reads faster than schema-pg ≈',
    '> database-pg. Absolute req/s and latency depend on the host, the pool sizes,',
    '> and the data volume of the run; read them as indicative shape, not a number',
    '> to quote.',
    '',
  ]
  if (env && env.platform !== 'linux') {
    const maxBudgetN = maxMeta(latest, 'mem', 'connection_budget', 'tenants')
    const maxCatalogK = maxMeta(latest, 'mem', 'catalog_bloat', 'schemas')
    const heavySmoke = maxBudgetN < 100 || maxCatalogK < 100
    lines.push(
      '> ⚠️ **Provisional dev-box snapshot — not a 1.0.0 sign-off.** Captured on',
      `> ${env.cpuModel} under \`${env.platform}\` (Docker Desktop), whose VM +`,
      '> network layer inflates DB latency and caps HTTP throughput, and the small',
      '> fixture pools (backoffice 4, tenant template 2) leave the HTTP tier',
      '> queue-bound under load.'
    )
    if (heavySmoke) {
      lines.push(
        '> The DB/memory tiers here also ran at smoke sizes (the catalog',
        '> planning-degradation curve still needs K ∈ {100, 1k, 5k}).'
      )
    }
    lines.push(
      '> Authoritative absolute numbers require this run on the Linux reference VM —',
      '> see `benchmarks/README.md`.',
      ''
    )
  }
  return lines
}

function buildMarkdown(latest: Map<string, ResultFile>): string {
  const files = [...latest.values()].sort((a, b) => a.suite.localeCompare(b.suite))
  const anyEnv = files[0]?.env
  const header = [
    '---',
    'title: Performance',
    'description: Measured throughput and latency for the tenancy hot paths, plus the connection budget and catalog-bloat curves.',
    '---',
    '',
    '# Performance',
    '',
    '> **Generated by `npm run bench:report`.** Do not edit by hand. Numbers come',
    '> from the benchmark suite in `benchmarks/`. The canonical 1.0.0 numbers are',
    '> captured on a dedicated Linux VM; see `benchmarks/README.md` for the spec.',
    '',
  ]
  if (!files.length) {
    return (
      header.join('\n') +
      '\n_No result files found in `benchmarks/results/`. Run `npm run bench:micro`' +
      ' (and the DB/HTTP/mem tiers) first, then re-run `npm run bench:report`._\n'
    )
  }
  if (anyEnv) {
    header.push(
      `_Last run: ${anyEnv.timestamp} · node ${anyEnv.node} · ${anyEnv.cpuModel}` +
        `${anyEnv.commit ? ` · commit ${anyEnv.commit}` : ''}._`,
      ''
    )
  }
  header.push(...caveat(anyEnv, latest))
  const sections = files.map(
    (f) => `## ${f.suite} — driver \`${f.env.driver}\`\n\n${sectionTable(f)}\n`
  )
  return header.join('\n') + '\n' + sections.join('\n')
}

function writeBaseline(name: string, latest: Map<string, ResultFile>): void {
  mkdirSync(BASELINES_DIR, { recursive: true })
  const index: Record<string, Record<string, { opsPerSec: number; nsMedian: number }>> = {}
  for (const file of latest.values()) {
    for (const e of flatten(file)) {
      const bucket = (index[e.key] ??= {})
      bucket[e.label] = { opsPerSec: e.opsPerSec, nsMedian: e.nsMedian }
    }
  }
  const env = [...latest.values()][0]?.env ?? null
  const path = new URL(`${name}.json`, BASELINES_DIR)
  writeFileSync(path, JSON.stringify({ capturedEnv: env, index }, null, 2))

  console.log(`→ wrote baseline ${name}.json`)
}

/**
 * Multi-run baseline: aggregate the `runs` newest files per suite/driver into a
 * median (with IQR, for the spread) so a quotable number averages out the
 * shared-runner CPU variance instead of resting on one run.
 */
function writeAggregatedBaseline(name: string, runs: number): void {
  mkdirSync(BASELINES_DIR, { recursive: true })
  const byKey = latestNBySuiteDriver(runs)
  const index: Record<
    string,
    Record<string, { opsPerSec: number; nsMedian: number; iqr: number; runs: number }>
  > = {}
  for (const [key, files] of byKey) {
    index[key] ??= {}
    // Collect each label's opsPerSec / nsMedian across the N files.
    const ops = new Map<string, number[]>()
    const nsm = new Map<string, number[]>()
    const append = (m: Map<string, number[]>, k: string, v: number) => {
      const arr = m.get(k) ?? []
      arr.push(v)
      m.set(k, arr)
    }
    for (const file of files) {
      for (const e of flatten(file)) {
        append(ops, e.label, e.opsPerSec)
        append(nsm, e.label, e.nsMedian)
      }
    }
    for (const [label, vals] of ops) {
      index[key][label] = {
        opsPerSec: Math.round(median(vals)),
        nsMedian: Math.round(median(nsm.get(label) ?? [])),
        iqr: Math.round(iqr(vals)),
        runs: vals.length,
      }
    }
  }
  const env = [...byKey.values()][0]?.[0]?.env ?? null
  const path = new URL(`${name}.json`, BASELINES_DIR)
  writeFileSync(
    path,
    JSON.stringify({ capturedEnv: env, aggregatedOverRuns: runs, index }, null, 2)
  )

  console.log(`→ wrote baseline ${name}.json (median of up to ${runs} runs per suite/driver)`)
}

/**
 * Replace the marked block in scaling-limits.md with a compact, generated
 * summary (per-driver HTTP req/s + the connection-budget verdict). Safe: if the
 * markers are absent or there is no data, it leaves the doc untouched.
 */
function injectScalingLimits(latest: Map<string, ResultFile>): void {
  let doc: string
  try {
    doc = readFileSync(SCALING_DOC, 'utf8')
  } catch {
    return
  }
  if (!doc.includes(INJECT_START) || !doc.includes(INJECT_END)) return

  const httpLines: string[] = []
  for (const [key, file] of latest) {
    if (!key.startsWith('http:')) continue
    const driver = file.env.driver
    const read = file.results.find((r) => r.name.includes('guarded'))
    if (read)
      httpLines.push(
        `- \`${driver}\` tenant read: **${read.opsPerSec.toLocaleString()} req/s** (p99 ${(read.ns.p99 / 1e6).toFixed(1)} ms)`
      )
  }
  const budget = [...latest.values()].find((f) => f.suite === 'mem')
  // Prefer the HONEST burst tier (production grace) over the steady tier, which
  // shrinks the grace so the cap appears to bind.
  const budgetLine = budget?.results
    .filter((r) => r.group === 'connection_budget_burst' && r.meta?.openDuringBurst !== undefined)
    .map(
      (r) =>
        `- ${r.name}: ${r.meta?.openDuringBurst} open tenant connections (cap ${r.meta?.cap}, ${r.meta?.capBounds})`
    )

  if (!httpLines.length && !budgetLine?.length) return

  const block = [
    INJECT_START,
    '**Per-driver HTTP throughput** (steady state, warmed connections):',
    '',
    ...(httpLines.length ? httpLines : ['- _no HTTP results yet_']),
    '',
    '**Connection budget** (under the default 30s grace, open connections track N, not the cap — front with PgBouncer):',
    '',
    ...(budgetLine?.length ? budgetLine : ['- _no memory results yet_']),
    '',
    `_Generated from the latest results; see [Performance](/docs/performance)._`,
    INJECT_END,
  ].join('\n')

  const re = new RegExp(`${INJECT_START}[\\s\\S]*?${INJECT_END}`)
  writeFileSync(SCALING_DOC, doc.replace(re, block))

  console.log('→ injected summary into docs/guides/scaling-limits.md')
}

const latest = latestBySuiteDriver()
const md = buildMarkdown(latest)
writeFileSync(PERF_DOC, md)

console.log(`→ wrote docs/guides/performance.md (${latest.size} suite/driver section(s))`)
injectScalingLimits(latest)

const writeArg = process.argv.find((a) => a.startsWith('--write-baseline='))
const runsArg = process.argv.find((a) => a.startsWith('--runs='))
const runs = runsArg ? Math.max(1, Number(runsArg.split('=')[1]) || 1) : 1
if (writeArg) {
  const name = writeArg.split('=')[1] || 'baseline'
  if (runs > 1) writeAggregatedBaseline(name, runs)
  else writeBaseline(name, latest)
} else if (runs > 1) {
  console.log(
    '--runs given without --write-baseline; nothing to aggregate into. Add --write-baseline=<name>.'
  )
}
