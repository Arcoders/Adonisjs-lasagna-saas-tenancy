import type { ApplicationService } from '@adonisjs/core/types'
import type { Database } from '@adonisjs/lucid/database'

/**
 * Resolve the Lucid `Database` from the container. The `'lucid.db'` binding is a
 * string alias Lucid registers but does not type on the container, so a direct
 * `container.make('lucid.db')` needs an `as never` cast to satisfy `make`'s typed
 * overloads. This helper is the ONE place that cast lives, so satellite providers stop
 * copy-pasting `container.make('lucid.db' as never)`; a caller narrows the returned
 * `Database` to the small query surface it actually uses.
 */
export function resolveLucidDb(app: ApplicationService): Promise<Database> {
  return app.container.make('lucid.db' as never) as Promise<Database>
}
