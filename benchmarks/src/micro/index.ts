/**
 * Tier 1: micro hot-paths. Pure CPU, no app, no DB. Run with `--expose-gc`
 * (the bench:micro script passes it) so the runner can GC between samples.
 */
import { installBenchConfig } from './setup.js'
import { printResults, type BenchResult } from '../harness/runner.js'
import { writeResult } from '../harness/results.js'
import { runTenantResolution } from './tenant_resolution.bench.js'
import { runAdapterRouting } from './adapter_routing.bench.js'
import { runConnectionLru } from './connection_lru.bench.js'
import { runRowscopePredicate } from './rowscope_predicate.bench.js'

installBenchConfig()

const results: BenchResult[] = [
  ...runTenantResolution(),
  ...runAdapterRouting(),
  ...runConnectionLru(),
  ...runRowscopePredicate(),
]

printResults('Tier 1 — micro hot-paths', results)
writeResult('micro', results)
process.exit(0)
