/**
 * Pure, app-free SSO helpers: no Redis, no network, no decorated models, so
 * they unit-test without a booted app. `sso_service.ts` delegates to these.
 * Keeping them in their own module is what lets a test import them in
 * isolation — importing the service itself pulls in the Redis service
 * singleton, which requires an Ignitor.
 */

/**
 * Assemble the OIDC authorization-request URL. The caller
 * (`SsoService.buildAuthUrl`) generates and persists `state`/`nonce`; this
 * only builds the query string, the deterministic, security-relevant part.
 */
export function buildAuthorizationUrl(
  authorizationEndpoint: string,
  params: {
    clientId: string
    redirectUri: string
    scopes: string[]
    state: string
    nonce: string
  }
): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    scope: params.scopes.join(' '),
    state: params.state,
    nonce: params.nonce,
  })
  return `${authorizationEndpoint}?${query}`
}

/**
 * Whether the issuer URL points at the loopback interface. Loopback issuers
 * are exempt from the SSRF guard in `discover()` because they are only used by
 * in-process test IdPs; the admin controller never accepts a loopback
 * issuerUrl from operator input.
 */
export function isLoopbackIssuer(issuerUrl: string): boolean {
  try {
    const u = new URL(issuerUrl)
    const h = u.hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
  } catch {
    return false
  }
}
