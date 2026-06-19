// The @japa/api-client plugin (registered by the satellite-test-kit's runner)
// augments Japa's TestContext with `client`, used by the integration specs that
// drive HTTP (tenant_guard_middleware, tenant_state_503, readyz_http, …).
//
// That `declare module` augmentation only applies if @japa/api-client is part of
// core's tsconfig program. It used to arrive incidentally, via a value import in
// a billing spec; that spec now lives in @adonisjs-lasagna/billing, so reference
// the module here explicitly. Type-only — at runtime the plugin supplies `client`.
import '@japa/api-client'
