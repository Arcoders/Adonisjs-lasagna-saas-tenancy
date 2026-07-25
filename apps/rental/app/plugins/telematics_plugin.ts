import {
  definePlugin,
  LASAGNA_PLUGIN_API_VERSION,
  requestMacro,
} from '@adonisjs-lasagna/saas-tenancy/plugin'
import { safeFetch, SafeFetchError } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'

/**
 * An app-owned plugin built on the SAME `definePlugin` facade the nine
 * satellites use — proof the plugin platform is open to host code. It adds a
 * `request.vehicleTelematics(vehicleId)` macro that queries an external
 * telematics provider through SSRF-pinned `safeFetch`: a provider URL that
 * resolves to a private/loopback/metadata address is refused fail-closed
 * (SafeFetchError), so a poisoned telematics endpoint can't be used to reach the
 * internal network.
 *
 * Registered in adonisrc.ts#providers (definePlugin returns a provider class).
 */
const TELEMATICS_BASE = process.env.TELEMATICS_BASE_URL ?? 'https://telematics.invalid'

export default definePlugin({
  name: 'telematics',
  packageName: 'karimoto-telematics',
  satelliteApi: 1,
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,

  requestMacros: () => [
    requestMacro({
      name: 'vehicleTelematics',
      requireTenant: true,
      resolve: () => {
        return async (
          vehicleId: string
        ): Promise<{ vehicleId: string; ok: boolean; detail?: unknown }> => {
          try {
            const res = await safeFetch(
              `${TELEMATICS_BASE}/vehicles/${encodeURIComponent(vehicleId)}/position`,
              {
                method: 'GET',
                timeoutMs: 3000,
              }
            )
            return { vehicleId, ok: res.ok, detail: await res.json().catch(() => null) }
          } catch (error) {
            if (error instanceof SafeFetchError) {
              return {
                vehicleId,
                ok: false,
                detail: { blocked: 'ssrf_guard', code: error.message },
              }
            }
            // Provider unreachable (the placeholder host never resolves) — degrade,
            // don't crash the request path.
            return { vehicleId, ok: false, detail: { unreachable: true } }
          }
        }
      },
    }),
  ],
})
