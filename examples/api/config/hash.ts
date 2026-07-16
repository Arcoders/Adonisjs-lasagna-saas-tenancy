import { defineConfig, drivers } from '@adonisjs/core/hash'
import type { InferHashers } from '@adonisjs/core/types'

/**
 * Password hashing for both auth realms (backoffice operators and tenant
 * users). scrypt ships with Node, so the demo needs no extra native dependency.
 */
const hashConfig = defineConfig({
  default: 'scrypt',
  list: {
    scrypt: drivers.scrypt({}),
  },
})

export default hashConfig

declare module '@adonisjs/core/types' {
  export interface HashersList extends InferHashers<typeof hashConfig> {}
}
