import { configure, processCLIArgs, run } from '@japa/runner'
import { assert } from '@japa/assert'
import { guaranteeGlobs } from '../../satellite-test-kit/src/guarantees.js'

// websockets' integration tier does NOT boot an AdonisJS Ignitor: its specs
// construct TenantSocketServer directly with stub deps (no container/boot
// dependency by design) and talk to real socket.io + Redis. So this is a plain
// Japa runner, not the satellite-test-kit's Ignitor harness. forceExit guards
// against a lingering socket/redis handle holding the process open after a green
// run; every spec still closes its servers and clients in teardown.
processCLIArgs(process.argv.splice(2))
configure({
  files: guaranteeGlobs().integration,
  plugins: [assert()],
  forceExit: true,
})
run()
