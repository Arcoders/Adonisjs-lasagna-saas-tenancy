import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { DoctorService } from '@adonisjs-lasagna/saas-tenancy/services'

/**
 * Same diagnostic the `node ace tenant:doctor --json` command emits, exposed
 * over HTTP. Useful for plugging the report into an external dashboard or
 * deploy gate. In production, mount this behind admin auth.
 */
@inject()
export default class DoctorController {
  constructor(private readonly doctor: DoctorService) {}

  async run({ request, response }: HttpContext) {
    const result = await this.doctor.run({
      checks: toArray(request.input('check')),
      tenants: toArray(request.input('tenant')),
      fix: request.input('fix') === 'true',
    })
    return response.ok(result)
  }
}

/** AdonisJS query parser returns string | string[] | undefined; normalise. */
function toArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (Array.isArray(value)) return value.map(String)
  return [String(value)]
}
