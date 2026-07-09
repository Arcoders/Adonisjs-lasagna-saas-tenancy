import { test } from '@japa/runner'
import {
  parseWorkerSandboxState,
  assertNativeAddonsSandboxable,
  NODE_SANDBOX_FLAGS,
} from '../../../../src/services/worker_sandbox.js'
import { definePlugin } from '../../../../src/sdk/define_plugin.js'
import { PLUGIN_API_CONTRACT_VERSION } from '../../../../src/sdk/plugin_api_version.js'
import type { SatelliteProviderContract } from '../../../../src/sdk/contract.js'
import type { ApplicationService } from '@adonisjs/core/types'

/**
 * S4b — the native-addon boot guard. A native (.node) addon evades the worker's
 * Node Permission Model, so a plugin shipping one must not silently run in a
 * sandboxed worker. These pin the argv parse and the fail-closed matrix (sandboxed
 * + no --allow-addons + declares native → abort; every other combination → allow).
 */

type Lifecycle = Required<SatelliteProviderContract>

test.group('worker sandbox — parseWorkerSandboxState', () => {
  test('reads --permission and --allow-addons from argv', ({ assert }) => {
    assert.deepEqual(parseWorkerSandboxState([]), {
      permissionEnabled: false,
      allowsAddons: false,
    })
    assert.deepEqual(parseWorkerSandboxState(['--permission']), {
      permissionEnabled: true,
      allowsAddons: false,
    })
    assert.deepEqual(parseWorkerSandboxState(['--permission', '--allow-addons']), {
      permissionEnabled: true,
      allowsAddons: true,
    })
  })

  test('NODE_SANDBOX_FLAGS carries --permission', ({ assert }) => {
    assert.include([...NODE_SANDBOX_FLAGS], '--permission')
  })
})

test.group('worker sandbox — assertNativeAddonsSandboxable', () => {
  test('aborts when sandboxed without --allow-addons', ({ assert }) => {
    try {
      assertNativeAddonsSandboxable('native-plugin', {
        permissionEnabled: true,
        allowsAddons: false,
      })
      assert.fail('should have thrown')
    } catch (err: any) {
      assert.equal(err.code, 'E_PLUGIN_BOOT')
      assert.equal(err.plugin, 'native-plugin')
      assert.equal(err.phase, 'nativeAddons')
      assert.match(err.message, /--allow-addons/)
    }
  })

  test('allows when the worker permits addons', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertNativeAddonsSandboxable('native-plugin', {
        permissionEnabled: true,
        allowsAddons: true,
      })
    )
  })

  test('allows in a non-sandboxed process (the API process)', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertNativeAddonsSandboxable('native-plugin', {
        permissionEnabled: false,
        allowsAddons: false,
      })
    )
  })
})

test.group('worker sandbox — facade wiring', () => {
  test('a nativeAddons plugin boots without throwing in the non-sandboxed test process', async ({
    assert,
  }) => {
    const Plugin = definePlugin({
      name: 'native',
      satelliteApi: 1,
      pluginApiVersion: PLUGIN_API_CONTRACT_VERSION,
      nativeAddons: true,
    })
    const instance = new Plugin({} as ApplicationService) as Lifecycle
    await assert.doesNotReject(() => instance.boot())
  })
})
