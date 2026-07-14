import type { ProviderInstaller } from './installer.js'
import { foundationWiring } from './foundation_wiring.js'
import { isolationWiring } from './isolation_wiring.js'
import { resolutionWiring } from './resolution_wiring.js'
import { tenancyContextWiring } from './tenancy_context_wiring.js'
import { resilienceWiring } from './resilience_wiring.js'
import { diagnosticsWiring } from './diagnostics_wiring.js'
import { auditWiring } from './audit_wiring.js'
import { pluginPlatformWiring } from './plugin_platform_wiring.js'
import { queueWiring } from './queue_wiring.js'
import { schedulerWiring } from './scheduler_wiring.js'
import { httpExtensionsWiring } from './http_extensions_wiring.js'

export type { InstallerContext, ProviderInstaller, BootLogger } from './installer.js'
export { createInstallerContext } from './installer.js'

/**
 * The ordered installer array the provider iterates. ARRAY ORDER == BOOT ORDER;
 * the provider runs register/boot/start/ready in this order and lets each
 * installer's `ready()`-armed teardown flow back through `addDisposer` for a LIFO
 * shutdown.
 *
 * The only hard within-boot ordering edge is FoundationWiring -> everything (its
 * `setConfig` is the precondition for every later `getConfig()`), so it goes
 * first. IsolationWiring precedes ResolutionWiring so the adapter is attached
 * early, but that pairing is order-free (the adapter reads both registries
 * lazily; only the resolver-registry OBJECT, present at register(), is needed).
 * The register-only support planes (resilience, diagnostics, audit) sit in the
 * middle. HttpExtensionsWiring is last: it only does start-phase macro install +
 * route autoload and consumes the resolution + plugin state the others wired.
 *
 * Reversed, this order yields the correct teardown ordering when combined with the
 * provider's shutdown steps: the queue's libuv handles (closeOwnedHandles) and the
 * module-cache resets (resetModuleCaches) run after the ready()-armed disposers.
 */
export const INSTALLERS: readonly ProviderInstaller[] = [
  foundationWiring,
  isolationWiring,
  resolutionWiring,
  tenancyContextWiring,
  resilienceWiring,
  diagnosticsWiring,
  auditWiring,
  pluginPlatformWiring,
  queueWiring,
  schedulerWiring,
  httpExtensionsWiring,
]
