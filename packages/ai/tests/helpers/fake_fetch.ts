import type { SafeFetchOptions } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import type { AIProviderDeps } from '../../src/providers/base_provider.js'

export interface FetchCall {
  url: string
  opts: SafeFetchOptions
}

/**
 * A fake transport for the provider adapters: records each call and returns a
 * caller-supplied Response (or throws), so the full adapter runs without a live
 * key or the network. `deps` plugs straight into a provider constructor.
 */
export function fakeFetch(respond: (call: FetchCall) => Response | Promise<Response>): {
  deps: AIProviderDeps
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const deps: AIProviderDeps = {
    async fetch(url, opts) {
      const call = { url, opts }
      calls.push(call)
      return respond(call)
    },
  }
  return { deps, calls }
}

/** A streaming SSE Response from a canned body string. */
export function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status })
}
