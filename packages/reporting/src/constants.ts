/**
 * The reporting extension-contract version: a single monotonic integer
 * identifying the shape of the {@link ./contracts/report_extension.js
 * ReportExtension} surface: the `execute(filters, options?, signal?)`
 * signature and the guarantees around it.
 *
 * A host extension declares the version it was built against via
 * `ReportExtension.contractVersion`; `ReportExtensionRegistry.register()`
 * compares it through `assertContractCompat` and rejects an incompatible one at
 * registration time.
 *
 * Bump this as a MAJOR: any backward-incompatible change to the extension
 * contract (a removed filter field, a changed `execute` shape) is a bump.
 * Additive, backward-compatible changes do NOT bump it. It is INDEPENDENT of
 * both `lasagnaSatellite.satelliteApi` (the ABI between satellite and core) and the
 * package's published version.
 */
export const REPORTING_CONTRACT_VERSION = 1
