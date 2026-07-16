/**
 * `@adonisjs-lasagna/saas-tenancy/mixins`: opt-in model mixins.
 *
 * Currently the data-change mixin: wrap a tenant model in
 * `TracksDataChanges` to emit a `TenantDataChanged` event after each committed
 * write, which `definePlugin({ onDataChange })` (or a raw `emitter.on`) subscribes
 * to. The change payload types are re-exported so a subscriber can type its handler
 * from this one import.
 */
// `__setDataChangeDispatcherForTests` is deliberately NOT re-exported here: it swaps
// a process-wide dispatch sink, so it stays off the public `/mixins` ABI (tests
// import it from the source module directly), mirroring `__configureTenancyForTests`.
export { TracksDataChanges } from './tracks_data_changes.js'
export type {
  TenantDataChangePayload,
  TenantDataChangeSubscription,
  TenantDataChangeOperation,
} from '../../events/tenant_data_changed.js'
export { default as TenantDataChanged } from '../../events/tenant_data_changed.js'
