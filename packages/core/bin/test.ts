import { runUnitSuite } from '../../satellite-test-kit/src/runner_entries.js'

// The unit + architectural specs run as a test environment. Without this NODE_ENV
// is unset, which the resolution-safety gate (assertConfigBounds, F5) treats as
// fail-closed like production — so a fixture config with a client-controlled
// strategy would hard-fail in the ambient env. Specs that need another environment
// override it explicitly via withNodeEnv(). `??=` respects an env set by CI.
process.env.NODE_ENV ??= 'test'

// Unit + architectural specs (the no-DB, source harness). The globs and Japa
// config live in the shared kit so every package's unit runner collapses to one
// identical line; see runUnitSuite. Imported from the kit SOURCE (not its build)
// so the fast unit loop still needs no build step.
runUnitSuite({ withArchitecture: true })
