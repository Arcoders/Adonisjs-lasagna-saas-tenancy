import { getStore } from '../config_store.js'

/**
 * Test-only: clear the config singleton so `getConfig()` throws again, used to
 * exercise the "config unreadable" fail-closed paths. Mirrors
 * `__configureTenancyForTests`; never call it from runtime code.
 */
export function __resetConfigForTests(): void {
  getStore().current = null
}
