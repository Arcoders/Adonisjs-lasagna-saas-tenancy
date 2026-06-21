import { test } from '@japa/runner'
import { spawn, spawnSync } from 'node:child_process'

/**
 * E2 — A satellite provider that throws in boot() must fail the app FAST and
 * name itself, not come up half-wired and 500 on the first request.
 *
 * The billing provider validates its driver eagerly in boot(): an unknown driver
 * throws `[billing] unknown driver "<name>"` before any network call
 * (billing_provider.ts). We spawn a fresh app process (the real deploy
 * entrypoint, `bin/server.ts`) with BILLING_DRIVER pointed at a bogus value and
 * assert a non-zero exit whose output names the satellite + the cause. Modeled on
 * boot_misconfig.spec.ts, which proves the same fail-fast contract for missing
 * env vars; this proves it for a satellite-provider boot throw.
 */
interface BootResult {
  code: number | null
  output: string
}

/** Kill the whole tree: with shell:true, killing the shell strands the grandchild tsx. */
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
    child.stdout.on('data', (d) => (output += String(d)))
    child.stderr.on('data', (d) => (output += String(d)))

    const killTimer = setTimeout(() => {
      if (child.pid) treeKill(child.pid)
      rejectPromise(new Error(`process did not exit within 45s. Output:\n${output}`))
    }, 45_000)

    child.on('error', (err) => {
      clearTimeout(killTimer)
      rejectPromise(err)
    })
    child.on('exit', (code) => {
      clearTimeout(killTimer)
      resolvePromise({ code, output })
    })
  })
}

test.group('e2e — satellite boot failure fails fast (E2)', () => {
  test('a billing driver that throws in boot() → non-zero exit naming the satellite + cause', async ({
    assert,
  }) => {
    // Keep the real environment (DB, APP_KEY, admin token are all present) so the
    // ONLY thing that fails is the satellite provider's boot validation.
    const env = { ...process.env }
    env.BILLING_DRIVER = '__not_a_real_driver__'
    // A distinct free port so an unexpected successful boot never collides with
    // the suite's running server.
    env.PORT = '3491'

    const { code, output } = await bootWithEnv(env)

    assert.isNotNull(code, 'process must exit on its own, not be killed (no partial start)')
    assert.notEqual(code, 0, `boot must fail with a bad billing driver. Output:\n${output}`)
    assert.include(output, '[billing]', 'the error must name the satellite so the operator can act')
    assert.include(
      output,
      '__not_a_real_driver__',
      'the error must name the offending driver (the cause)'
    )
  }).timeout(60_000)
})
