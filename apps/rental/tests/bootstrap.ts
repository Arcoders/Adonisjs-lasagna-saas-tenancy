import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import type { Config } from '@japa/runner/types'

export const plugins: Config['plugins'] = [assert(), apiClient(), pluginAdonisJS(app)]

export const configureSuite: Config['configureSuite'] = (suite) => {
  if (suite.name === 'e2e') {
    suite.setup(() => testUtils.httpServer().start())
  }
}
