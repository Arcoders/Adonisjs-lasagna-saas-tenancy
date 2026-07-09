/**
 * The crypto satellite contract version: a single monotonic integer identifying
 * the shape of crypto's public surface the other data-protection satellites and
 * host callers depend on (the `KeyProvider` interface, the `WrappedDek` envelope,
 * the `CryptoService` seal/open/shred surface).
 *
 * Bump this as a MAJOR on any backward-incompatible change to that surface. It is
 * INDEPENDENT of both `lasagnaSatellite.satelliteApi` (the satellite-to-core ABI)
 * and the package's published npm version, mirroring `AI_CONTRACT_VERSION`.
 */
export const CRYPTO_CONTRACT_VERSION = 1
