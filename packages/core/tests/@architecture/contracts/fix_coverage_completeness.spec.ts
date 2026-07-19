import { test } from '@japa/runner'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SAFE_FIXES,
  SAFE_FIX_BY_CODE,
  SURFACE_ONLY,
} from '../../../src/services/doctor/safe_fix_registry.js'

/**
 * C1 + C2 — "the doctor never harms the patient", enforced as a build gate.
 *
 * C1 (per-code descriptor completeness): every code emitted with `fixable: true` has a
 * {@link SafeFix} descriptor AND is not in {@link SURFACE_ONLY}. A fixable code that is
 * un-declared, or is mislabelled surface-only (which the runtime would still auto-fix,
 * since the check calls the envelope directly), fails CI.
 *
 * C2 (coverage completeness): EVERY code any doctor check can emit is either
 * fixable-with-a-descriptor or explicitly surface-only, with no dead registry entries.
 * Codes must be STATIC string literals — a dynamic (template-literal) `code:` is invisible
 * to the census and is rejected outright.
 */
const CHECKS_DIR = fileURLToPath(new URL('../../../src/services/doctor/checks/', import.meta.url))

// `code: 'snake_case_or_digits'` — a STATIC string literal.
const CODE_LITERAL = /\bcode:\s*['"]([a-z0-9_]+)['"]/g
// A dynamic `code:` — a backtick template literal. These defeat the census and are banned.
const CODE_TEMPLATE = /\bcode:\s*`/g
const FIXABLE_TRUE = /\bfixable:\s*true\b/g

function checkFiles(): string[] {
  return readdirSync(CHECKS_DIR).filter((f) => f.endsWith('.ts') && f !== 'index.ts')
}

/** Strip line + block comments so prose mentioning `code:` cannot trip the census. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function emittedCodes(): Set<string> {
  const codes = new Set<string>()
  for (const file of checkFiles()) {
    const src = readFileSync(join(CHECKS_DIR, file), 'utf8')
    for (const m of src.matchAll(CODE_LITERAL)) codes.add(m[1]!)
  }
  return codes
}

/** Files (with line context) that use a dynamic template-literal `code:`. */
function dynamicCodeSites(): string[] {
  const sites: string[] = []
  for (const file of checkFiles()) {
    const src = stripComments(readFileSync(join(CHECKS_DIR, file), 'utf8'))
    if (CODE_TEMPLATE.test(src)) sites.push(file)
    CODE_TEMPLATE.lastIndex = 0
  }
  return sites
}

/**
 * Codes emitted WITH `fixable: true`, paired per-code: each `fixable: true` occurrence is
 * attributed to the nearest PRECEDING `code:` literal in the same file (the checks always
 * write `code:` before `fixable:` inside an issue object). This is what makes C1 per-code
 * rather than per-file, so a new fixable code without a descriptor is actually caught.
 */
function fixableEmittedCodes(): Set<string> {
  const out = new Set<string>()
  for (const file of checkFiles()) {
    const src = readFileSync(join(CHECKS_DIR, file), 'utf8')
    const codes = [...src.matchAll(CODE_LITERAL)].map((m) => ({ code: m[1]!, index: m.index! }))
    for (const fm of src.matchAll(FIXABLE_TRUE)) {
      let best: { code: string; index: number } | null = null
      for (const c of codes) {
        if (c.index < fm.index! && (!best || c.index > best.index)) best = c
      }
      if (best) out.add(best.code)
    }
  }
  return out
}

test.group('doctor fix-coverage completeness (do-no-harm, machine-enforced)', () => {
  test('every emitted issue code is either a registered SafeFix or an explicit SURFACE_ONLY', ({
    assert,
  }) => {
    const covered = new Set<string>([...SAFE_FIX_BY_CODE.keys(), ...SURFACE_ONLY.keys()])
    const uncovered = [...emittedCodes()].filter((c) => !covered.has(c))
    assert.deepEqual(
      uncovered,
      [],
      `these doctor codes are neither fixable-with-a-descriptor nor surface-only. ` +
        `Add each to SAFE_FIXES (with a proven effect class) or SURFACE_ONLY (with a reason): ${uncovered.join(', ')}`
    )
  })

  test('no doctor code is emitted as a dynamic (template-literal) code:', ({ assert }) => {
    assert.deepEqual(
      dynamicCodeSites(),
      [],
      `these checks emit a dynamic \`code:\` template literal, which the census cannot see. ` +
        `Use a STATIC code and put the variable part in meta: ${dynamicCodeSites().join(', ')}`
    )
  })

  test('every code emitted with fixable:true has a SafeFix descriptor and is NOT surface-only', ({
    assert,
  }) => {
    const offenders: string[] = []
    for (const code of fixableEmittedCodes()) {
      if (!SAFE_FIX_BY_CODE.has(code)) offenders.push(`${code} (fixable but no SafeFix descriptor)`)
      else if (SURFACE_ONLY.has(code)) offenders.push(`${code} (fixable but also listed surface-only)`)
    }
    assert.deepEqual(
      offenders,
      [],
      `a code the doctor auto-fixes MUST be a registered SafeFix and never surface-only: ${offenders.join(', ')}`
    )
  })

  test('there are no dead registry entries — every SafeFix/SURFACE_ONLY code is actually emitted', ({
    assert,
  }) => {
    const emitted = emittedCodes()
    const dead = [...SAFE_FIX_BY_CODE.keys(), ...SURFACE_ONLY.keys()].filter((c) => !emitted.has(c))
    assert.deepEqual(dead, [], `these registry codes are no longer emitted by any check: ${dead.join(', ')}`)
  })

  test('a code is never BOTH fixable-registered and surface-only', ({ assert }) => {
    const both = [...SAFE_FIX_BY_CODE.keys()].filter((c) => SURFACE_ONLY.has(c))
    assert.deepEqual(both, [], `these codes are declared both fixable and surface-only: ${both.join(', ')}`)
  })

  test('every SafeFix declares a valid effect class + envelope, and reconcile is physical-identity', ({
    assert,
  }) => {
    const classes = new Set(['operational-only', 'status-only', 'additive-only', 'physical-identity'])
    const envelopes = new Set(['circuit', 'status', 'heal', 'reconcile'])
    for (const fix of SAFE_FIXES) {
      assert.isTrue(classes.has(fix.effectClass), `${fix.code}: bad effectClass ${fix.effectClass}`)
      assert.isTrue(envelopes.has(fix.envelope), `${fix.code}: bad envelope ${fix.envelope}`)
      if (fix.envelope === 'heal') assert.equal(fix.effectClass, 'additive-only', fix.code)
      if (fix.envelope === 'status') assert.equal(fix.effectClass, 'status-only', fix.code)
      if (fix.envelope === 'circuit') assert.equal(fix.effectClass, 'operational-only', fix.code)
      if (fix.envelope === 'reconcile') assert.equal(fix.effectClass, 'physical-identity', fix.code)
    }
  })
})
