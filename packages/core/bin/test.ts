import { configure, processCLIArgs, run } from '@japa/runner'
import { assert } from '@japa/assert'

processCLIArgs(process.argv.splice(2))
configure({
  files: ['tests/unit/**/*.spec.ts', 'tests/architectural/**/*.spec.ts'],
  plugins: [assert()],
})
run()
