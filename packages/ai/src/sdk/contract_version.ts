/**
 * The AI provider-contract version: a single monotonic integer identifying the
 * shape of the {@link ../types/ai_provider_contract.js AIProviderContract}
 * surface (the `stream(request, signal)` signature, the `StreamFragment` and
 * `AIStreamRequest` shapes, and the declared `capabilities`).
 *
 * A provider declares the version it was built against via
 * `AIProviderContract.contractVersion`; `AIProviderRegistry.register()` compares
 * it through `assertContractCompat` and rejects an incompatible one at
 * registration time (newer than this build throws; older or absent warns).
 *
 * Bump this as a MAJOR: any backward-incompatible change to the provider
 * contract (a removed field, a changed `stream` shape, a newly REQUIRED
 * capability) is a bump. The presence gate is orthogonal to this number, so a
 * newly required capability must bump it rather than rely on the warn-on-older
 * asymmetry. It is INDEPENDENT of both `lasagnaSatellite.satelliteApi` (the
 * satellite-to-core ABI) and the package's published version.
 */
export const AI_CONTRACT_VERSION = 1
