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
import { discoverSatelliteProviders } from './lib/discover-satellites.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

/**
 * Satellites that ship a provider, DISCOVERED from source (manifest `provider` +
 * a `providers/*_provider.ts`), never a hand-list — so crypto, the template, and any
 * future provider are covered automatically. sso/admin ship none, so nothing here.
 */
const PROVIDERS = discoverSatelliteProviders(ROOT)

/** The current Plugin API (facade) contract version, read from core's single source. */
function currentPluginApiVersion() {
  const src = readFileSync(r('packages/core/src/sdk/plugin_api_version.ts'), 'utf8')
  const m = src.match(/PLUGIN_API_CONTRACT_VERSION\s*=\s*(\d+)/)
  return m ? Number.parseInt(m[1], 10) : undefined
}

const CALL_RE = /assertSatelliteApiCompatAtBoot\(\s*\{\s*satelliteApi:\s*(\d+)\s*\}/
// A definePlugin facade declares the same literal as a spec field; the facade
// runs the boot-time assert for it. Non-greedy so the FIRST satelliteApi after
// `definePlugin({` is the one captured, regardless of field order.
const DEFINE_PLUGIN_RE = /definePlugin\(\s*\{[\s\S]*?\bsatelliteApi:\s*(\d+)/

// A definePlugin facade may declare pluginApiVersion as a numeric literal or as the
// named LASAGNA_PLUGIN_API_VERSION constant (which equals the current contract).
const DEFINE_PLUGIN_PAV_RE = /definePlugin\(\s*\{[\s\S]*?\bpluginApiVersion:\s*(LASAGNA_PLUGIN_API_VERSION|\d+)/

/**
 * Pure rule: given provider source + the package's declared satelliteApi (and, for a
 * definePlugin facade, the manifest's pluginApiVersion + the current contract), return
 * problems.
 */
function lint(providerSrc, declaredApi, manifestPav, currentPav) {
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
  // Plugin-API (facade) mirror: a definePlugin facade that declares pluginApiVersion
  // MUST have the same value declared in package.json#lasagnaSatellite.pluginApiVersion,
  // killing the phantom field. A raw provider (no facade pluginApiVersion) is not
  // required to declare it yet.
  const pav = providerSrc.match(DEFINE_PLUGIN_PAV_RE)
  if (pav) {
    const expected = pav[1] === 'LASAGNA_PLUGIN_API_VERSION' ? currentPav : Number.parseInt(pav[1], 10)
    if (manifestPav !== expected) {
      problems.push(
        `pluginApiVersion: the definePlugin facade declares ${expected} but ` +
          `package.json#lasagnaSatellite.pluginApiVersion is ${manifestPav ?? '(absent)'}`
      )
    }
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
  if (lint(facade, 1, 1, 1).length !== 0) failures.push('definePlugin good fixture flagged')
  if (lint(facade, 2, 1, 1).length === 0) failures.push('definePlugin mismatched-version passed')
  if (lint("export default definePlugin({ name: 'x' })", 1).length === 0) {
    failures.push('definePlugin without satelliteApi passed')
  }
  // pluginApiVersion mirror: facade declares it, manifest must match.
  if (lint(facade, 1, 2, 1).length === 0) failures.push('pluginApiVersion mismatch passed')
  const facadeNamed = "export default definePlugin({ name: 'x', satelliteApi: 1, pluginApiVersion: LASAGNA_PLUGIN_API_VERSION })"
  if (lint(facadeNamed, 1, 1, 1).length !== 0) failures.push('named pluginApiVersion good fixture flagged')
  if (lint(facadeNamed, 1, undefined, 1).length === 0) failures.push('absent manifest pluginApiVersion passed')
  if (failures.length) {
    console.error('check-abi-boot-assertion --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-abi-boot-assertion --self-test: OK')
  process.exit(0)
}

const currentPav = currentPluginApiVersion()
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
  const manifestPav = pkg?.lasagnaSatellite?.pluginApiVersion
  for (const p of lint(readFileSync(r(s.provider), 'utf8'), declaredApi, manifestPav, currentPav)) {
    errors.push(`${s.key}: ${p}`)
  }
}

if (errors.length > 0) {
  console.error('check-abi-boot-assertion: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-abi-boot-assertion: OK (${PROVIDERS.length} providers verified)`)
