import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { captureEnv, type BenchEnv } from './env.js'
import type { BenchResult } from './runner.js'

export const RESULTS_DIR = new URL('../../results/', import.meta.url)

export interface ResultFile {
  suite: string
  env: BenchEnv
  results: BenchResult[]
  meta?: Record<string, unknown>
}

/**
 * Write a suite's results to `results/<suite>-<driver>-<timestamp>.json`,
 * stamped with the env block. Returns the path written.
 */
export function writeResult(
  suite: string,
  results: BenchResult[],
  opts: { pgVersion?: string | null; meta?: Record<string, unknown> } = {}
): string {
  mkdirSync(RESULTS_DIR, { recursive: true })
  const env = captureEnv(opts.pgVersion ?? null)
  const payload: ResultFile = { suite, env, results, meta: opts.meta }
  const stamp = env.timestamp.replace(/[:.]/g, '-')
  const fileName = `${suite}-${env.driver}-${stamp}.json`
  const path = new URL(fileName, RESULTS_DIR)
  writeFileSync(path, JSON.stringify(payload, null, 2))
  // eslint-disable-next-line no-console
  console.log(`\n→ wrote ${fileName}`)
  return path.pathname
}

/** Load every result file, newest first. */
export function loadResults(): ResultFile[] {
  let names: string[]
  try {
    names = readdirSync(RESULTS_DIR).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  return names
    .map((n) => JSON.parse(readFileSync(new URL(n, RESULTS_DIR), 'utf8')) as ResultFile)
    .sort((a, b) => b.env.timestamp.localeCompare(a.env.timestamp))
}

/** Latest result file per `<suite>-<driver>` pair. */
export function latestBySuiteDriver(): Map<string, ResultFile> {
  const map = new Map<string, ResultFile>()
  for (const r of loadResults()) {
    const key = `${r.suite}:${r.env.driver}`
    if (!map.has(key)) map.set(key, r) // loadResults is newest-first
  }
  return map
}
