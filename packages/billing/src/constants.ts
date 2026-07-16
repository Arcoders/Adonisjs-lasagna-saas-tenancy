/**
 * The billing driver-contract version: a single monotonic integer identifying
 * the shape of the {@link ./contracts/billing_provider_contract.js
 * BillingProviderContract} surface a driver implements.
 *
 * A driver declares the version it was built against via
 * `BillingProviderContract.contractVersion`; `BillingDriverRegistry.register()`
 * compares it through `assertContractCompat` and rejects an incompatible driver
 * at registration time.
 *
 * Bump as a MAJOR for any backward-incompatible change to the driver contract.
 * INDEPENDENT of `lasagnaSatellite.satelliteApi` and the published version.
 */
export const BILLING_CONTRACT_VERSION = 1
