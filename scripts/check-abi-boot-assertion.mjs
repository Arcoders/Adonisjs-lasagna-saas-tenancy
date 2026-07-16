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
// The guard mirror-checks THREE per-provider boot surfaces the same way — declare
// it in the facade (or a raw boot() call) and keep the manifest coherent:
//   - satelliteApi (the Satellite ABI, required in every provider);
//   - pluginApiVersion (the definePlugin facade contract, required in every provider);
//   - nativeAddons (a boolean; the boot-time sandbox fail-closed, required ONLY when
//     package.json#lasagnaSatellite.nativeAddons is true — a manifest that claims
//     native addons but never wires assertNativeAddonsSandboxable silently disables
//     the --permission worker guard, which this catches).
//
// WS-7 / abi-contract-check-configure-time-only + plugin-platform Lote A + Wave 5 EXT-5.
// Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { discoverSatelliteProviders } from './lib/discover-satellites.mjs'
import { stripJsComments } from './lib/strip-js-comments.mjs'

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

// A definePlugin facade may declare nativeAddons as a boolean literal (the facade
// wires assertNativeAddonsSandboxable when it is `true`).
const DEFINE_PLUGIN_NATIVE_RE = /definePlugin\(\s*\{[\s\S]*?\bnativeAddons:\s*(true|false)/

/**
 * Pure rule: given provider source + the package's declared satelliteApi (and, for a
 * definePlugin facade, the manifest's pluginApiVersion + the current contract + the
 * manifest's nativeAddons flag), return problems.
 */
function lint(providerSrc, declaredApi, manifestPav, currentPav, manifestNative) {
  const problems = []
  // Scan CODE only: a version literal or flag that appears in a comment or a string
  // (a doc example, a `"https://…"` URL) must never be read as the declared value.
  const src = stripJsComments(providerSrc)
  const m = src.match(CALL_RE) ?? src.match(DEFINE_PLUGIN_RE)
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
  // killing the phantom field.
  const pav = src.match(DEFINE_PLUGIN_PAV_RE)
  if (pav) {
    const expected = pav[1] === 'LASAGNA_PLUGIN_API_VERSION' ? currentPav : Number.parseInt(pav[1], 10)
    if (manifestPav !== expected) {
      problems.push(
        `pluginApiVersion: the definePlugin facade declares ${expected} but ` +
          `package.json#lasagnaSatellite.pluginApiVersion is ${manifestPav ?? '(absent)'}`
      )
    }
  }
  // Plugin-API (facade) backstop REQUIRED in EVERY provider (plugin-platform Wave 3,
  // enforceable now the fleet is fully on definePlugin): a provider must assert the
  // plugin-API contract at boot, not only the Satellite ABI. Two shapes satisfy it —
  // a definePlugin facade declaring `pluginApiVersion` (the facade runs
  // assertPluginApiCompatAtBoot for it), or a hand-written provider calling
  // assertPluginApiCompatAtBoot(...) in boot() itself.
  const hasPluginApiBackstop = Boolean(pav) || /\bassertPluginApiCompatAtBoot\s*\(/.test(src)
  if (!hasPluginApiBackstop) {
    problems.push(
      'boot() does not assert the plugin-API contract: declare `pluginApiVersion` in the ' +
        'definePlugin({ … }) facade, or call assertPluginApiCompatAtBoot(<n>, …) in a raw boot()'
    )
  }
  // nativeAddons mirror: a facade that declares the flag must agree with the manifest,
  // so the install-time consent gate / doctor / health-check (which read the manifest)
  // and the boot-time sandbox assert (driven by the facade) never disagree.
  const nativeFacade = src.match(DEFINE_PLUGIN_NATIVE_RE)
  const facadeNative = nativeFacade ? nativeFacade[1] === 'true' : undefined
  // The runtime manifest parser (manifest.ts) DROPS a non-boolean nativeAddons, so a
  // truthy-non-boolean value here (`1`, `"yes"`) is treated as absent, not honored —
  // otherwise the mirror and backstop would disagree with what the app actually reads.
  const hasNativeAddons = manifestNative === true
  if (facadeNative !== undefined && facadeNative !== hasNativeAddons) {
    problems.push(
      `nativeAddons: the definePlugin facade declares ${facadeNative} but ` +
        `package.json#lasagnaSatellite.nativeAddons is ${manifestNative ?? '(absent)'}`
    )
  }
  // nativeAddons backstop, CONDITIONAL on the manifest: when the manifest claims native
  // addons, the provider MUST wire the boot-time sandbox fail-closed
  // (assertNativeAddonsSandboxable) — a facade declaring `nativeAddons: true` runs it,
  // or a raw boot() calls it directly. Without it, a native addon loads in a --permission
  // worker with no --allow-addons and the guard is silently absent. A plugin with no
  // native addons needs nothing here.
  if (hasNativeAddons) {
    const wiresNativeAssert =
      facadeNative === true || /\bassertNativeAddonsSandboxable\s*\(/.test(src)
    if (!wiresNativeAssert) {
      problems.push(
        'package.json#lasagnaSatellite.nativeAddons is true but boot() does not wire the ' +
          'sandbox fail-closed: declare `nativeAddons: true` in the definePlugin({ … }) facade, ' +
          'or call assertNativeAddonsSandboxable(<name>) in a raw boot()'
      )
    }
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const failures = []
  // A raw provider now needs BOTH backstops: the Satellite ABI and the plugin-API.
  const good =
    'async boot(){ assertSatelliteApiCompatAtBoot({ satelliteApi: 1 }, "@x/y"); assertPluginApiCompatAtBoot(1, "@x/y") }'
  if (lint(good, 1).length !== 0) failures.push('good fixture flagged')
  if (lint('async boot(){ /* nothing */ }', 1).length === 0) failures.push('missing-call fixture passed')
  if (lint(good, 2).length === 0) failures.push('mismatched-version fixture passed')
  // A raw provider with the ABI backstop but NO plugin-API backstop now fails.
  const rawNoPluginApi = 'async boot(){ assertSatelliteApiCompatAtBoot({ satelliteApi: 1 }, "@x/y") }'
  if (lint(rawNoPluginApi, 1).length === 0) failures.push('raw provider without plugin-API backstop passed')
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
  // nativeAddons mirror + conditional backstop.
  const facadeNative = "export default definePlugin({ name: 'x', satelliteApi: 1, pluginApiVersion: 1, nativeAddons: true })"
  if (lint(facadeNative, 1, 1, 1, true).length !== 0) failures.push('nativeAddons good fixture flagged')
  if (lint(facadeNative, 1, 1, 1, false).length === 0) failures.push('nativeAddons facade/manifest drift passed')
  if (lint(facadeNative, 1, 1, 1, undefined).length === 0) failures.push('nativeAddons facade vs absent manifest passed')
  // manifest claims native addons but neither facade nor raw assert wires the boot guard.
  if (lint(facade, 1, 1, 1, true).length === 0) failures.push('manifest nativeAddons without boot assertion passed')
  // a raw provider that DOES call the sandbox assert satisfies the conditional backstop.
  const rawWithNative =
    'async boot(){ assertSatelliteApiCompatAtBoot({ satelliteApi: 1 }, "@x/y"); assertPluginApiCompatAtBoot(1, "@x/y"); assertNativeAddonsSandboxable("@x/y") }'
  if (lint(rawWithNative, 1, undefined, 1, true).length !== 0) failures.push('raw provider with native assert flagged')
  // a plugin WITHOUT native addons needs no sandbox assertion (absent or false manifest).
  if (lint(facade, 1, 1, 1, false).length !== 0) failures.push('non-native plugin spuriously flagged')
  if (lint(facade, 1, 1, 1, undefined).length !== 0) failures.push('absent-native plugin spuriously flagged')
  // a facade honestly declaring nativeAddons: false: accepted against absent/false, flagged
  // against a true manifest (pins the false branch + the Boolean-normalization of the mirror).
  const facadeFalse =
    "export default definePlugin({ name: 'x', satelliteApi: 1, pluginApiVersion: 1, nativeAddons: false })"
  if (lint(facadeFalse, 1, 1, 1, undefined).length !== 0) failures.push('nativeAddons:false vs absent flagged')
  if (lint(facadeFalse, 1, 1, 1, false).length !== 0) failures.push('nativeAddons:false vs false flagged')
  if (lint(facadeFalse, 1, 1, 1, true).length === 0) failures.push('nativeAddons:false vs true passed')
  // a truthy-non-boolean manifest value (`1`) is treated as absent, matching the runtime
  // parser — no phantom drift against a false facade, no phantom backstop against none.
  if (lint(facadeFalse, 1, 1, 1, 1).length !== 0) failures.push('truthy-non-boolean manifest not normalized (mirror)')
  if (lint(facade, 1, 1, 1, 1).length !== 0) failures.push('truthy-non-boolean manifest not normalized (backstop)')
  // a field mentioned in a comment INSIDE the facade braces must NOT be read as declared
  // (without comment-stripping the block comment's `nativeAddons: true` would false-flag drift).
  const facadeCommented =
    "export default definePlugin({ name: 'x', satelliteApi: 1, pluginApiVersion: 1, /* set nativeAddons: true if you ship a .node addon */ })"
  if (lint(facadeCommented, 1, 1, 1, undefined).length !== 0) failures.push('commented field misread')
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
  const manifestNative = pkg?.lasagnaSatellite?.nativeAddons
  for (const p of lint(
    readFileSync(r(s.provider), 'utf8'),
    declaredApi,
    manifestPav,
    currentPav,
    manifestNative
  )) {
    errors.push(`${s.key}: ${p}`)
  }
}

if (errors.length > 0) {
  console.error('check-abi-boot-assertion: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-abi-boot-assertion: OK (${PROVIDERS.length} providers verified)`)
