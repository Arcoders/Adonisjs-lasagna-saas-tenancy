import { defineConfig, drivers } from '@adonisjs/core/hash'
import type { InferHashers } from '@adonisjs/core/types'

/**
 * Password hashing for both auth realms (backoffice operators and tenant
 * staff). scrypt ships with Node, so no native dependency is needed.
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
