/**
 * The `docs:doctor` CLI (RFC §7). Exit codes: 0 clean, 1 a blocking gate finding,
 * 2 a tool/internal error, so CI can tell "docs drifted" from "the tool broke".
 *
 *   docs:doctor [--since <ref>] [--package <name>] [--json | --summary]
 *               [--update-baseline] [--update-freshness] [--explain <symbol>]
 *               [--why <doc#section>] [--graph] [--init-anchors]
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig, findRepoRoot } from './config.js'
import { runDoctor } from './doctor.js'
import { runGate, DEFAULT_SEVERITY } from './gate.js'
import { loadBaseline, saveBaseline, BASELINE_VERSION } from './baseline.js'
import { loadFreshness, saveFreshness, FRESHNESS_VERSION } from './freshness.js'
import { freshnessPairings } from './signals.js'
import { formatHuman, formatJson, formatJobSummary } from './report.js'
import { explainSymbol, whyDoc } from './explain.js'
import { initAnchors } from './init_anchors.js'

interface ParsedArgs {
  flags: Set<string>
  values: Map<string, string>
}

const VALUE_FLAGS = new Set(['--since', '--package', '--explain', '--why'])

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>()
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (VALUE_FLAGS.has(a)) {
      values.set(a, argv[++i] ?? '')
    } else if (a.startsWith('--') && a.includes('=')) {
      const [k, v] = a.split(/=(.*)/s)
      values.set(k, v)
    } else {
      flags.add(a)
    }
  }
  return { flags, values }
}

export function main(argv: string[]): number {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error('docs:doctor: bad arguments:', (err as Error).message)
    return 2
  }

  const repoRoot = findRepoRoot(process.cwd())

  try {
    const config = defaultConfig(repoRoot)
    if (args.values.has('--package')) {
      const only = args.values.get('--package')!
      config.packages = config.packages.filter(
        (p) => p.name === only || p.name.endsWith(`/${only}`)
      )
    }

    const since = args.values.get('--since')
    const freshnessPath = join(repoRoot, 'doc-coverage.freshness.json')
    const freshness = loadFreshness(freshnessPath)
    const result = runDoctor(config, { since, freshness })

    if (args.flags.has('--graph')) {
      const path = join(repoRoot, 'doc-graph.json')
      writeFileSync(path, JSON.stringify(result.graph, null, 2))
      console.log(`wrote ${path}`)
    }

    if (args.values.has('--explain')) {
      console.log(explainSymbol(result.graph, args.values.get('--explain')!))
      return 0
    }
    if (args.values.has('--why')) {
      console.log(whyDoc(result.graph, args.values.get('--why')!))
      return 0
    }
    if (args.flags.has('--init-anchors')) {
      console.log(initAnchors(result.graph))
      return 0
    }

    const baselinePath = join(repoRoot, 'doc-coverage.baseline.json')
    const baseline = loadBaseline(baselinePath)
    const gate = runGate(result, config, DEFAULT_SEVERITY, baseline)

    if (args.flags.has('--update-baseline')) {
      saveBaseline(baselinePath, {
        version: BASELINE_VERSION,
        findings: gate.allKeys,
        floors: config.coverageFloors,
      })
      console.log(`wrote ${baselinePath} (${gate.allKeys.length} accepted finding key(s))`)
      return 0
    }

    // Snapshot the current contract hash of every D3 pairing as "reviewed". Run
    // this after reviewing the docs a contract change flagged: it records that
    // the prose matches the symbol at its present contract, so D3 goes quiet
    // until the contract changes again. Uses the same pairing set the checker
    // does (`freshnessPairings`), so the snapshot and the check never diverge.
    if (args.flags.has('--update-freshness')) {
      const ignored = new Set(result.freshnessIgnore)
      const reviewed: Record<string, string> = {}
      for (const { node, page } of freshnessPairings(result.graph, ignored)) {
        reviewed[`${node.id}|${page}`] = node.signatureHash!
      }
      saveFreshness(freshnessPath, { version: FRESHNESS_VERSION, reviewed })
      console.log(`wrote ${freshnessPath} (${Object.keys(reviewed).length} reviewed pairing(s))`)
      return 0
    }

    if (args.flags.has('--json')) {
      console.log(formatJson(result, gate))
    } else if (args.flags.has('--summary')) {
      console.log(formatJobSummary(result, gate))
    } else {
      console.log(formatHuman(result, gate))
    }

    return gate.blocking.length > 0 ? 1 : 0
  } catch (err) {
    console.error('docs:doctor: tool error:', (err as Error).stack ?? err)
    return 2
  }
}
