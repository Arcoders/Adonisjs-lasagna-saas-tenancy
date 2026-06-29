import { test } from '@japa/runner'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A misconfigured deploy must die at boot with a readable error, not come up
 * half-working and fail on the first request. Each case spawns a fresh app
 * process (`tsx bin/server.ts`, the same entrypoint the deploy images run)
 * with one required env var removed and asserts a non-zero exit that names
 * the missing variable.
 *
 * Deployed images carry no .env file — config arrives purely through the
 * environment — so each child gets ENV_PATH pointed at an empty directory.
 * Without that, the Adonis env loader would read examples/api/.env from cwd
 * and quietly fill the hole this spec is creating.
 *
 * Package-level boot validations (impersonation secret length, admin routes
 * without middleware, isolation driver choice) are covered by the core
 * integration suite — this spec covers the app-level env contract.
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
    // The real production entrypoint (`npm start`, deploy images): ts-exec,
    // not tsx, because @inject() needs decorator metadata tsx cannot emit.
    // shell: true so the command resolves on both POSIX and Windows.
    const child = spawn('node --import=@poppinss/ts-exec bin/server.ts', {
      cwd: process.cwd(),
      env,
      shell: true,
      detached: process.platform !== 'win32',
    })

    let output = ''
    child.stdout.on('data', (d) => (output += String(d)))
    child.stderr.on('data', (d) => (output += String(d)))

    // env validation runs in a preload, well before the HTTP server binds;
    // a process still alive after 45s means it booted when it should not have.
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

test.group('e2e — misconfigured boot fails fast', () => {
  const cases: Array<{ varName: string; port: string }> = [
    { varName: 'APP_KEY', port: '3471' },
    { varName: 'DB_HOST', port: '3472' },
    { varName: 'DEMO_ADMIN_TOKEN', port: '3473' },
  ]

  for (const { varName, port } of cases) {
    test(`missing ${varName} → non-zero exit naming the variable`, async ({ assert }) => {
      const emptyEnvDir = await mkdtemp(join(tmpdir(), 'lasagna-noenv-'))
      const env = { ...process.env }
      delete env[varName]
      env.ENV_PATH = emptyEnvDir
      // A distinct free port per case so an unexpected successful boot never
      // collides with the suite's server or a sibling case.
      env.PORT = port

      const { code, output } = await bootWithEnv(env)
      assert.isNotNull(code, 'process must exit on its own, not be killed')
      assert.notEqual(code, 0, `boot must fail without ${varName}. Output:\n${output}`)
      assert.include(output, varName, `the error must name ${varName} so the operator can act`)
    }).timeout(60_000)
  }
})
