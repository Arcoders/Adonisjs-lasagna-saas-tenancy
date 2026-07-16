/**
 * Open registry of capabilities a plugin can `provide` and another can `consume`
 * for OPTIONAL, degradable composition, the type-level twin of
 * `SatelliteConfigRegistry`. Core declares it empty; each plugin augments it via
 *
 * ```ts
 * declare module '@adonisjs-lasagna/saas-tenancy/plugin' {
 *   interface LasagnaCapabilities {
 *     email: EmailApi
 *   }
 * }
 * ```
 *
 * so `CapabilityRegistry.consume('email')` is typed `EmailApi | undefined` ONLY in
 * a compilation that imports that plugin. A host that never installs it sees no
 * `email` key. Direct-import + `dependsOn` stays the path for HARD dependencies;
 * this registry is for "use it if installed" degradable composition.
 */
export interface LasagnaCapabilities {}
