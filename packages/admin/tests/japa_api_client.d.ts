// The @japa/api-client plugin (registered by the satellite-test-kit's runner)
// augments Japa's TestContext with `client`, used by the integration specs that
// drive the admin REST endpoints over HTTP.
//
// That `declare module` augmentation only applies if @japa/api-client is part of
// admin's tsconfig program, and nothing else here imports it: the specs only ever
// destructure `client` off the context. Reference the module explicitly so the
// augmentation lands. Type-only: at runtime the plugin supplies `client`.
import '@japa/api-client'
