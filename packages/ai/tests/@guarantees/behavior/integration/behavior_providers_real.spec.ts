import { test } from '@japa/runner'
import ClaudeProvider from '../../../../src/providers/claude_provider.js'
import {
  DeepSeekProvider,
  KimiProvider,
} from '../../../../src/providers/openai_compatible_provider.js'
import { collect } from '../../../helpers/sse_source.js'
import type { AIProviderContract } from '../../../../src/types/ai_provider_contract.js'

/**
 * Real-API smokes, one row per provider. Each streams a tiny prompt from the LIVE
 * API through the real pinned fetch and asserts it returns fragments and settles
 * real token counts. Self-skips when its key is absent (CI has no keys by
 * default), à la the Stripe / SSO convention: a `*_real.spec.ts` exercises a live
 * external dependency; everything else uses an in-process double.
 */
const PROVIDERS: {
  name: string
  envKey: string
  make: (apiKey: string) => AIProviderContract
}[] = [
  { name: 'claude', envKey: 'ANTHROPIC_API_KEY', make: (apiKey) => new ClaudeProvider({ apiKey }) },
  {
    name: 'deepseek',
    envKey: 'DEEPSEEK_API_KEY',
    make: (apiKey) => new DeepSeekProvider({ apiKey }),
  },
  { name: 'kimi', envKey: 'MOONSHOT_API_KEY', make: (apiKey) => new KimiProvider({ apiKey }) },
]

test.group('providers: real-API smoke', () => {
  for (const provider of PROVIDERS) {
    test(`${provider.name} streams from the live API and settles real tokens`, async ({
      assert,
    }) => {
      const impl = provider.make(process.env[provider.envKey] as string)
      const fragments = await collect(
        impl.stream(
          { messages: [{ role: 'user', content: 'Reply with a single word.' }], maxTokens: 16 },
          AbortSignal.timeout(20_000)
        )
      )
      assert.isAbove(fragments.length, 0, 'the live API returned at least one fragment')
      const tokens = fragments.reduce((sum, f) => sum + f.tokens, 0)
      assert.isAbove(tokens, 0, 'the live API reported real token usage')
    }).skip(!process.env[provider.envKey], `${provider.envKey} not set`)
  }
})
