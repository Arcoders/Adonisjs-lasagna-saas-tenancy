import { test } from '@japa/runner'
import { spawn, spawnSync } from 'node:child_process'

/**
 * A satellite provider that throws in boot() must fail the app FAST and name
 * itself, not come up half-wired and 500 on the first request.
 *
 * The billing provider validates its driver eagerly in boot(): an unknown driver
 * throws `[billing] unknown driver "<name>"` before any network call
 * (billing_provider.ts). We spawn a fresh app process (the real deploy entrypoint,
 * `bin/server.ts`) with BILLING_DRIVER pointed at a bogus value and assert that
 * boot fails with a message naming the satellite + the cause.
 *
 * Why we detect the error in the output rather than waiting for a clean exit:
 * unlike boot_misconfig.spec.ts, whose env-validation failures happen in a preload
 * BEFORE any connection opens (so the process exits immediately), a provider
 * boot() throw happens AFTER the core providers have opened Postgres / Redis /
 * queue handles. Those open handles keep the event loop alive, so the process does
 * not self-exit. The contract we care about is fail-fast during boot with a named
 * cause; the failure surfacing during `Application.boot` already proves the app
 * never reached the serving stage. So we resolve as soon as the signature appears
 * and tear the child down.
 */
const FAILURE_SIGNATURE = '[billing] unknown driver'

interface BootResult {
  /** True if the child exited on its own; false if we killed it after detecting the failure. */
  exited: boolean
  code: number | null
  output: string
}

/** Kill the whole tree: with shell:true, killing the shell strands the grandchild. */
function treeKill(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync(`taskkill /pid ${pid} /T /F`, { shell: true })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      process.kill(pid, 'SIGKILL')
    }
  }
}

function bootWithEnv(env: NodeJS.ProcessEnv): Promise<BootResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    // ts-exec, not tsx: @inject() needs decorator metadata tsx cannot emit.
    const child = spawn('node --import=@poppinss/ts-exec bin/server.ts', {
      cwd: process.cwd(),
      env,
      shell: true,
      detached: process.platform !== 'win32',
    })

    let output = ''
    let settled = false

    const finish = (result: BootResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Tear down if the failure was detected while the (handle-pinned) process
      // was still alive.
      if (!result.exited && child.pid) treeKill(child.pid)
      resolvePromise(result)
    }

    const onData = (d: unknown) => {
      output += String(d)
      if (output.includes(FAILURE_SIGNATURE)) finish({ exited: false, code: null, output })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)

    const timer = setTimeout(() => {
      if (child.pid) treeKill(child.pid)
      if (!settled) {
        settled = true
        rejectPromise(new Error(`boot did not fail within 40s. Output:\n${output}`))
      }
    }, 40_000)

    child.on('error', (err) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        rejectPromise(err)
      }
    })
    // A self-exit (e.g. the entrypoint force-exits on a boot error) is also fine.
    child.on('exit', (code) => finish({ exited: true, code, output }))
  })
}

test.group('e2e — satellite boot failure fails fast (E2)', () => {
  test('a billing driver that throws in boot() fails the boot, naming the satellite + cause', async ({
    assert,
  }) => {
    // Keep the real environment (DB, APP_KEY, admin token are all present) so the
    // ONLY thing that fails is the satellite provider's boot validation.
    const env = { ...process.env }
    env.BILLING_DRIVER = '__not_a_real_driver__'
    // A distinct free port so an unexpected successful boot never collides with
    // the suite's running server.
    env.PORT = '3491'

    const { exited, code, output } = await bootWithEnv(env)

    assert.include(output, '[billing]', 'the error must name the satellite so the operator can act')
    assert.include(
      output,
      '__not_a_real_driver__',
      'the error must name the offending driver (the cause)'
    )
    // If the process did exit on its own, it must be a failure exit, never a clean 0.
    if (exited) {
      assert.notEqual(code, 0, `a failed boot must not exit 0. Output:\n${output}`)
    }
  }).timeout(60_000)
})
