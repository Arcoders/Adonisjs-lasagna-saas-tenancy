import HookRegistry from '../../services/hook_registry.js'
import EvaluationStrategyRegistry from '../../services/evaluation_strategy_registry.js'
import WebhookTransformerRegistry from '../../services/webhook_transformer_registry.js'
import AuthorizerRegistry from '../../services/authorizer_registry.js'
import TenantMiddlewareRegistry from '../../services/tenant_middleware_registry.js'
import CapabilityRegistry from '../../services/capability_registry.js'
import TenantSchedulerService from '../../services/tenant_scheduler_service.js'
import { assertPluginLimits } from '../assert_plugin_limits.js'
import type { MultitenancyConfig } from '../../types/config.js'
import type { InstallerContext, ProviderInstaller } from './installer.js'

/**
 * The plugin/extension platform: the host- and plugin-populated Map-backed
 * registries (all singletons so a plugin's boot-time registrations are visible
 * where core consumes them — the authorizer chain in TenantGuardMiddleware, the
 * middleware registry when installRouterMacros pre-resolves each scope, the
 * capability registry at consume time), the declarative hook loader, and the
 * fail-closed surface-cap enforcement.
 */
export const pluginPlatformWiring: ProviderInstaller = {
  name: 'plugin-platform',

  register(ctx: InstallerContext): void {
    ctx.app.container.singleton(HookRegistry, () => new HookRegistry())
    ctx.app.container.singleton(AuthorizerRegistry, () => new AuthorizerRegistry())
    ctx.app.container.singleton(TenantMiddlewareRegistry, () => new TenantMiddlewareRegistry())
    ctx.app.container.singleton(CapabilityRegistry, () => new CapabilityRegistry())
    ctx.app.container.singleton(EvaluationStrategyRegistry, () => new EvaluationStrategyRegistry())
    ctx.app.container.singleton(WebhookTransformerRegistry, () => new WebhookTransformerRegistry())
  },

  async boot(ctx: InstallerContext): Promise<void> {
    const config = ctx.app.config.get<MultitenancyConfig>('multitenancy')
    const hooks = await ctx.app.container.make(HookRegistry)
    hooks.loadDeclarative(config.hooks)
  },

  async start(ctx: InstallerContext): Promise<void> {
    const config = ctx.app.config.get<MultitenancyConfig>('multitenancy')

    // Fail-closed cap enforcement for the plugin request-path surfaces. Runs here,
    // in start(), because every provider's boot() has completed, so a plugin's
    // authorizer/middleware/capability/schedule registrations are final and
    // countable. A surface over its configured cap aborts the deploy
    // (PluginBootException); an omitted cap is unlimited. No-op unless a host sets
    // `plugins.limits`. The schedule count is a safe cross-subsystem read of
    // SchedulerWiring's singleton (all registrations are final by start()).
    const [authorizers, middleware, capabilities, scheduler] = await Promise.all([
      ctx.app.container.make(AuthorizerRegistry),
      ctx.app.container.make(TenantMiddlewareRegistry),
      ctx.app.container.make(CapabilityRegistry),
      ctx.app.container.make(TenantSchedulerService),
    ])
    assertPluginLimits(config.plugins?.limits, {
      authorizers: authorizers.list().length,
      middleware: middleware.list().length,
      capabilities: capabilities.list().length,
      schedules: scheduler.list().length,
    })
  },
}
