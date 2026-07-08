import { definePlugin, LASAGNA_PLUGIN_API_VERSION } from '@adonisjs-lasagna/saas-tenancy/plugin'

/**
 * Provider for `@adonisjs-lasagna/admin`, built with the {@link definePlugin}
 * facade. Admin is a LIBRARY satellite: the host mounts `multitenancyAdminRoutes`
 * and supplies its own auth middleware + actor resolver, so this provider declares
 * no seams and binds no singletons. Its sole job is the runtime backstop — the
 * facade asserts the Satellite ABI and the plugin-API contract at `boot()`, so a
 * later core downgrade underneath an already-configured host fails fast instead of
 * drifting silently.
 *
 * The configure hook registers this provider in the host's `adonisrc.ts`
 * (`registerSatelliteInRcFile`, driven by `package.json#lasagnaSatellite.provider`),
 * so every satellite in the fleet — library or not — asserts the plugin contract
 * uniformly at boot.
 */
export default definePlugin({
  name: 'admin',
  packageName: '@adonisjs-lasagna/admin',
  // Mirrors package.json#lasagnaSatellite.satelliteApi (check-abi-boot-assertion
  // pins these against each other so the literal can't drift).
  satelliteApi: 1,
  // The definePlugin facade contract this satellite was built against.
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,
})
