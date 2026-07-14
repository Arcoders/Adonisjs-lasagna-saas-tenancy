import TenantSchedulerService from '../../services/tenant_scheduler_service.js'
import type { InstallerContext, ProviderInstaller } from './installer.js'

/**
 * Fans a periodic tick out over active tenants. Singleton so a plugin's boot-time
 * schedule registrations are the ones `ready()` arms as native @adonisjs/queue
 * schedules.
 */
export const schedulerWiring: ProviderInstaller = {
  name: 'scheduler',

  register(ctx: InstallerContext): void {
    ctx.app.container.singleton(TenantSchedulerService, () => new TenantSchedulerService())
  },

  /**
   * Arm plugin schedules as native @adonisjs/queue schedules. Runs in ready()
   * (after every provider boot(), so all schedule registrations are final AND the
   * queue backend is initialized). As its own installer it always runs, regardless
   * of whether the opt-in resolution cache is enabled — the property the old inline
   * ordering ("scheduler.start BEFORE the cache early-return") preserved. Fail-closed
   * in the worker/console process (a declared schedule that can't be armed aborts the
   * deploy); fail-open in the web process (the worker arms the shared schedule anyway,
   * so a queue-backend blip must not fail web readiness). No-op unless a plugin
   * registered a schedule.
   */
  async ready(ctx: InstallerContext): Promise<void> {
    const env = ctx.app.getEnvironment()
    await (
      await ctx.app.container.make(TenantSchedulerService)
    ).start({
      failClosed: env !== 'web',
    })
  },
}
