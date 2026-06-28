/**
 * Output formatting (RFC §7). Human text mirrors Ismael's mockup; `--json` is for
 * automation; the job-summary form is GitHub-flavoured markdown. Tier 1 is the
 * gate, Tier 2 is advisory; the split is always visible.
 */
import type { DoctorResult } from './doctor.js'
import type { GateOutcome } from './gate.js'

// Drop the npm scope (`@scope/`) for a readable display id, for any package.
const short = (id: string): string => id.replace(/^@[^/]+\//, '')

export function formatHuman(result: DoctorResult, gate: GateOutcome): string {
  const out: string[] = []
  const c = result.coverage

  // Tier 1: the gate.
  const gateMark = gate.blocking.length === 0 ? '✓' : '✗'
  const deadMembers = result.d2hard.length
  out.push(
    `${gateMark} Tier 1 (gate): ${deadMembers} dead member(s) in prose, ` +
      `coverage floor ${gate.coverageFloorOk ? 'met' : 'BELOW'}` +
      (gate.blocking.length ? `, ${gate.blocking.length} blocking` : '')
  )
  for (const b of gate.blocking) out.push(`    ✗ ${b.message}`)

  // Tier 2: advisory.
  const advisory = result.d3.length + result.d2soft.length + result.d4.length
  out.push(`⚠ Tier 2 (advisory): ${advisory} review item(s)`)
  for (const f of result.d3.slice(0, 30)) {
    out.push(`  - ${f.doc} (-> ${short(f.symbol)}): ${f.reason}`)
    out.push(`      Action: review whether the change needs a doc update.`)
    out.push(`      Suppress: <!-- doc:freshness-ignore reason="..." -->`)
  }
  for (const f of result.d2soft.slice(0, 30)) {
    out.push(
      `  - ${f.doc} (-> ${short(f.symbol)}): prose missing ${f.missing.map((m) => `"${m}"`).join(', ')}`
    )
    out.push(`      Action: mention the term(s), or map a synonym in doc-synonyms.json.`)
  }
  for (const f of result.d4.slice(0, 20)) {
    out.push(
      `  - ${f.doc} (-> ${short(f.symbol)}): ${f.hops}-hop static reach now includes ${short(f.reaches)}`
    )
    out.push(`      Action: confirm the prose still describes the path (DI edges not detected).`)
  }

  out.push(
    `Coverage: explained ${c.pct.explained}%, exemplified-only ${c.pct.exemplified}%, ` +
      `uncovered ${c.pct.uncovered}% (${c.total} public symbols)`
  )
  if (result.warnings.length) out.push(`Notes: ${result.warnings.length} graph warning(s)`)
  return out.join('\n')
}

export function formatJobSummary(result: DoctorResult, gate: GateOutcome): string {
  const c = result.coverage
  const lines: string[] = []
  lines.push('## docs:doctor')
  lines.push('')
  lines.push(
    gate.blocking.length === 0
      ? '**Tier 1 (gate): passing**'
      : `**Tier 1 (gate): ${gate.blocking.length} blocking**`
  )
  for (const b of gate.blocking) lines.push(`- \`✗\` ${b.message}`)
  lines.push('')
  lines.push(
    `**Tier 2 (advisory):** ${result.d3.length} freshness, ${result.d2soft.length} token-gap, ${result.d4.length} reach`
  )
  lines.push('')
  lines.push('| Coverage | % | n |')
  lines.push('|---|---|---|')
  lines.push(`| explained | ${c.pct.explained}% | ${c.explained} |`)
  lines.push(`| exemplified-only | ${c.pct.exemplified}% | ${c.exemplified} |`)
  lines.push(`| uncovered | ${c.pct.uncovered}% | ${c.uncovered} |`)
  return lines.join('\n')
}

export function formatJson(result: DoctorResult, gate: GateOutcome): string {
  return JSON.stringify(
    {
      coverage: result.coverage,
      gate: { blocking: gate.blocking, coverageFloorOk: gate.coverageFloorOk },
      d2hard: result.d2hard,
      d2soft: result.d2soft,
      d3: result.d3,
      d4: result.d4,
      warnings: result.warnings,
    },
    null,
    2
  )
}
