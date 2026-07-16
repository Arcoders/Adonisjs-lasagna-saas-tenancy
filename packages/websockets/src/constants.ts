/**
 * The websockets extension-contract version: a single monotonic integer
 * identifying the shape of the authorization seam (`authorize(socket, tenant)`)
 * and the handshake/room contract around it.
 *
 * The `authorize` hook can be supplied as a bare function (the simple,
 * unversioned form) or as an object `{ contractVersion?, authorize }` that opts
 * into the compatibility check at wiring time via `assertContractCompat`.
 *
 * Bump as a MAJOR for any backward-incompatible change to that surface.
 * INDEPENDENT of `lasagnaSatellite.satelliteApi` and the published version.
 */
export const WEBSOCKETS_CONTRACT_VERSION = 1
