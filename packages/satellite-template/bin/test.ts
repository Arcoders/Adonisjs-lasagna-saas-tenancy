import { runUnitSuite } from '../../satellite-test-kit/src/runner_entries.js'

// Reference satellite: the unit runner is one line, the canonical shape a
// consumer copies. Globs and Japa config come from the shared kit (runUnitSuite),
// which discovers tests/@guarantees/<g>/unit/** in the guarantee tree.
runUnitSuite()
