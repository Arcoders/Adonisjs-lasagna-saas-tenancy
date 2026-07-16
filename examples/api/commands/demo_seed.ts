import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Seeds the demo operator account (the backoffice realm's identity) so a
 * fresh checkout can log in and reach the admin API. Idempotent: re-running
 * updates the same row. `npm run setup` chains it after backoffice:setup.
 */
export default class DemoSeed extends BaseCommand {
  static readonly commandName = 'demo:seed'
  static readonly description = 'Seed the demo operator account for the backoffice auth realm'
  static readonly options: CommandOptions = { startApp: true }

  async run() {
    if (this.app.inProduction) {
      this.logger.error(
        'demo:seed creates well-known credentials and refuses to run in production.'
      )
      this.exitCode = 1
      return
    }

    const { default: BackofficeUser } = await import('#app/models/backoffice/backoffice_user')
    const { DEMO_OPERATOR } = await import('#app/helpers/demo_credentials')

    await BackofficeUser.updateOrCreate(
      { email: DEMO_OPERATOR.email },
      { password: DEMO_OPERATOR.password, fullName: DEMO_OPERATOR.fullName }
    )

    this.logger.success(`Operator ready: ${DEMO_OPERATOR.email} / ${DEMO_OPERATOR.password}`)
    this.logger.info(
      'Log in with POST /backoffice/login and send the returned token as ' +
        '"Authorization: Bearer <token>" to /admin, /metrics and /admin/reporting.'
    )
  }
}
