import os from 'node:os'
import { execSync } from 'node:child_process'

export interface BenchEnv {
  driver: string
  node: string
  platform: string
  arch: string
  cpuModel: string
  cpuCount: number
  totalMemGB: number
  commit: string | null
  pgVersion: string | null
  timestamp: string
}

function gitCommit(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return null
  }
}

/**
 * Static machine + run metadata stamped into every result file, so a number is
 * never separated from the box that produced it. `pgVersion` is filled in by
 * the DB/memory tiers (they can `SELECT version()`); micro runs leave it null.
 */
export function captureEnv(pgVersion: string | null = null): BenchEnv {
  const cpus = os.cpus()
  return {
    driver: process.env.BENCH_DRIVER ?? 'schema-pg',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemGB: Math.round((os.totalmem() / 1e9) * 10) / 10,
    commit: gitCommit(),
    pgVersion,
    timestamp: new Date().toISOString(),
  }
}
