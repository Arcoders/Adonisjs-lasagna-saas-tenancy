import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineLoader } from 'vitepress'

/**
 * Build-time source of truth for the two fleet-wide contract integers the home
 * page advertises. Reading them out of `packages/core/src/sdk/` means a bump to
 * either constant updates the landing page on the next build, so the marketing
 * surface cannot drift away from the code the way a hardcoded literal would.
 *
 * `docs/` is not an npm workspace, so nothing type-checks this file. The parse
 * failure is therefore a runtime `throw`: VitePress awaits `load()` inside its
 * Vite `load` hook, so a throw aborts `docs:build` instead of silently blanking
 * the section.
 */
export interface ContractsData {
  satelliteApi: number
  pluginApi: number
}

interface Source {
  /** Relative to THIS file. Three levels up from `docs/.vitepress/theme/` is the repo root. */
  file: string
  constant: string
  re: RegExp
}

const SOURCES: Record<keyof ContractsData, Source> = {
  satelliteApi: {
    file: '../../../packages/core/src/sdk/api_version.ts',
    constant: 'SATELLITE_API_VERSION',
    re: /export const SATELLITE_API_VERSION\s*=\s*(\d+)/,
  },
  pluginApi: {
    file: '../../../packages/core/src/sdk/plugin_api_version.ts',
    constant: 'PLUGIN_API_CONTRACT_VERSION',
    re: /export const PLUGIN_API_CONTRACT_VERSION\s*=\s*(\d+)/,
  },
}

function readContractVersion(source: Source): number {
  const path = fileURLToPath(new URL(source.file, import.meta.url))
  const match = readFileSync(path, 'utf8').match(source.re)

  if (!match) {
    throw new Error(
      `[contracts.data] Could not parse ${source.constant} from ${source.file}. ` +
        `The home page's "Extensible by contract" section derives its value from that constant. ` +
        `If the constant moved or was renamed, update docs/.vitepress/theme/contracts.data.ts.`
    )
  }

  return Number(match[1])
}

// VitePress replaces this module's body with the `load()` result and synthesizes
// a named `data` export. Declaring it keeps consumers typed.
export declare const data: ContractsData

export default defineLoader({
  watch: [
    '../../../packages/core/src/sdk/api_version.ts',
    '../../../packages/core/src/sdk/plugin_api_version.ts',
  ],
  load(): ContractsData {
    return {
      satelliteApi: readContractVersion(SOURCES.satelliteApi),
      pluginApi: readContractVersion(SOURCES.pluginApi),
    }
  },
})
