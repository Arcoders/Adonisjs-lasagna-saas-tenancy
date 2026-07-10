import { runUnitSuite } from '../../satellite-test-kit/src/runner_entries.js'

// The scaffolder is pure logic plus one thin executor, so it has no integration
// harness: there is no Ignitor and no database to boot. Globs and Japa config
// come from the shared kit, which discovers tests/@guarantees/<g>/unit/**.
runUnitSuite({ withArchitecture: true })
