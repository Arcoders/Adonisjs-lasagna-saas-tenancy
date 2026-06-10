import IsolationConfigException from '../../exceptions/isolation_config_exception.js'

/**
 * Fails the boot when `config.isolation.driver` names a driver nobody
 * registered. `IsolationDriverChoice` admits custom names (the registry is
 * open by design), so a typo compiles — without this check it would surface
 * only on the first tenant query, as a generic "no active driver" error
 * that never mentions the misconfigured value.
 *
 * Called from the provider's `start()`, after every provider's `boot()` has
 * run, so a custom driver registered in the host's `boot()` (the pattern the
 * custom-isolation-driver cookbook teaches) is already visible. Lives in its
 * own module (no service imports) so the unit suite can exercise it without
 * booting an Ignitor.
 */
export function assertConfiguredDriverRegistered(
  registry: { has(name: string): boolean; list(): readonly string[] },
  choice: string
): void {
  if (registry.has(choice)) return
  throw new IsolationConfigException(
    `multitenancy.isolation.driver is "${choice}" but no driver with that name is registered. ` +
      `Registered: ${registry.list().join(', ') || '(none)'}. Built-in drivers activate ` +
      `automatically; a custom driver must be registered in your provider's boot() ` +
      `(see the custom-isolation-driver cookbook).`
  )
}
