#!/usr/bin/env node
// Guards that every satellite that ships a PROVIDER asserts the Satellite ABI at
// boot(), and that the satelliteApi literal it declares matches the package's own
// package.json#lasagnaSatellite.satelliteApi (single source of truth — the literal
// can't drift). configure gates ABI once at install; this is the runtime backstop
// for a later core downgrade.
//
// Two provider shapes satisfy the rule, and both surface the same literal:
//   1. a hand-written provider calls assertSatelliteApiCompatAtBoot({ satelliteApi: n }, …)
//      directly in boot();
//   2. a definePlugin({ satelliteApi: n, … }) facade gets that exact boot-time
//      assert wired inside the facade (see sdk/define_plugin.ts), so the `n` it
//      declares in the spec is the literal this guard pins against package.json.
//
// WS-7 / abi-contract-check-configure-time-only + plugin-platform Lote A. Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

/** Satellites that ship a provider (sso/admin ship none, so nothing to assert). */
const PROVIDERS = [
  { key: 'billing', provider: 'packages/billing/providers/billing_provider.ts', pkg: 'packages/billing/package.json' },
  { key: 'backup', provider: 'packages/backup/providers/backup_provider.ts', pkg: 'packages/backup/package.json' },
  { key: 'reporting', provider: 'packages/reporting/providers/reporting_provider.ts', pkg: 'packages/reporting/package.json' },
  { key: 'websockets', provider: 'packages/websockets/providers/websockets_provider.ts', pkg: 'packages/websockets/package.json' },
  { key: 'ai', provider: 'packages/ai/providers/ai_provider.ts', pkg: 'packages/ai/package.json' },
]

const CALL_RE = /assertSatelliteApiCompatAtBoot\(\s*\{\s*satelliteApi:\s*(\d+)\s*\}/
// A definePlugin facade declares the same literal as a spec field; the facade
// runs the boot-time assert for it. Non-greedy so the FIRST satelliteApi after
// `definePlugin({` is the one captured, regardless of field order.
const DEFINE_PLUGIN_RE = /definePlugin\(\s*\{[\s\S]*?\bsatelliteApi:\s*(\d+)/

/** Pure rule: given provider source + the package's declared satelliteApi, return problems. */
function lint(providerSrc, declaredApi) {
  const problems = []
  const m = providerSrc.match(CALL_RE) ?? providerSrc.match(DEFINE_PLUGIN_RE)
  if (!m) {
    problems.push(
      'boot() neither calls assertSatelliteApiCompatAtBoot({ satelliteApi: <n> }, …) ' +
        'nor is the provider a definePlugin({ satelliteApi: <n>, … }) facade'
    )
    return problems
  }
  const literal = Number.parseInt(m[1], 10)
  if (literal !== declaredApi) {
    problems.push(`satelliteApi literal ${literal} != package.json#lasagnaSatellite.satelliteApi ${declaredApi}`)
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const failures = []
  const good = 'async boot(){ assertSatelliteApiCompatAtBoot({ satelliteApi: 1 }, "@x/y") }'
  if (lint(good, 1).length !== 0) failures.push('good fixture flagged')
  if (lint('async boot(){ /* nothing */ }', 1).length === 0) failures.push('missing-call fixture passed')
  if (lint(good, 2).length === 0) failures.push('mismatched-version fixture passed')
  // definePlugin facade form: the spec's satelliteApi literal is what gets pinned.
  const facade = "export default definePlugin({ name: 'x', satelliteApi: 1, pluginApiVersion: 1 })"
  if (lint(facade, 1).length !== 0) failures.push('definePlugin good fixture flagged')
  if (lint(facade, 2).length === 0) failures.push('definePlugin mismatched-version passed')
  if (lint("export default definePlugin({ name: 'x' })", 1).length === 0) {
    failures.push('definePlugin without satelliteApi passed')
  }
  if (failures.length) {
    console.error('check-abi-boot-assertion --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-abi-boot-assertion --self-test: OK')
  process.exit(0)
}

const errors = []
for (const s of PROVIDERS) {
  if (!existsSync(r(s.provider))) {
    errors.push(`${s.key}: missing provider ${s.provider}`)
    continue
  }
  if (!existsSync(r(s.pkg))) {
    errors.push(`${s.key}: missing ${s.pkg}`)
    continue
  }
  const pkg = JSON.parse(readFileSync(r(s.pkg), 'utf8'))
  const declaredApi = pkg?.lasagnaSatellite?.satelliteApi
  if (typeof declaredApi !== 'number') {
    errors.push(`${s.key}: ${s.pkg} has no numeric lasagnaSatellite.satelliteApi`)
    continue
  }
  for (const p of lint(readFileSync(r(s.provider), 'utf8'), declaredApi)) {
    errors.push(`${s.key}: ${p}`)
  }
}

if (errors.length > 0) {
  console.error('check-abi-boot-assertion: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-abi-boot-assertion: OK (${PROVIDERS.length} providers verified)`)
