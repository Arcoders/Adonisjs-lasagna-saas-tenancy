import { assertContractCompat } from '../sdk/contract_version.js'

/**
 * The webhook payload-transformer contract version: the shape of
 * {@link WebhookPayloadTransformer}. Bump as a MAJOR for a backward-incompatible
 * change. INDEPENDENT of `satelliteApi` and the published version.
 */
export const WEBHOOKS_CONTRACT_VERSION = 1

/**
 * A host-registered hook that rewrites a webhook payload before it is signed and
 * delivered. Applied ONCE, in `WebhookService.dispatch()`, before the delivery
 * row is persisted, so the stored payload is exactly what gets signed and what
 * retries re-send. Implementations must be pure (no IO in the signing path) and
 * return a plain JSON object.
 */
export interface WebhookPayloadTransformer {
  readonly name: string
  /** Contract version this transformer was built against (see {@link WEBHOOKS_CONTRACT_VERSION}). */
  readonly contractVersion?: number
  transform(event: string, payload: Record<string, unknown>): Record<string, unknown>
}

/**
 * Registry of host webhook payload transformers. Bound as a container singleton
 * by `MultitenancyProvider`; the host registers transformers in its provider
 * `boot()`. Transformers form a chain applied in registration order. Map-backed
 * (stateful): resolve via `container.make`, never `new` ad hoc.
 *
 * When empty (the default), `WebhookService` skips transformation entirely, so
 * the delivered + signed body is byte-identical to a build without this surface.
 */
export default class WebhookTransformerRegistry {
  readonly #transformers = new Map<string, WebhookPayloadTransformer>()

  /** The transformer-contract version this surface implements. */
  get contractVersion(): number {
    return WEBHOOKS_CONTRACT_VERSION
  }

  register(transformer: WebhookPayloadTransformer): this {
    if (!transformer.name || typeof transformer.name !== 'string') {
      throw new Error('WebhookTransformerRegistry: a transformer must have a non-empty name.')
    }
    if (this.#transformers.has(transformer.name)) {
      throw new Error(
        `WebhookTransformerRegistry: a transformer named "${transformer.name}" is already registered.`
      )
    }
    assertContractCompat(
      transformer.contractVersion,
      WEBHOOKS_CONTRACT_VERSION,
      `webhook transformer "${transformer.name}"`
    )
    this.#transformers.set(transformer.name, transformer)
    return this
  }

  /** Registered transformers, in registration order. */
  list(): readonly WebhookPayloadTransformer[] {
    return [...this.#transformers.values()]
  }

  has(name: string): boolean {
    return this.#transformers.has(name)
  }

  clear(): this {
    this.#transformers.clear()
    return this
  }

  /**
   * Apply every transformer in registration order. Each receives the output of
   * the previous one. Throws if a transformer returns anything but a plain
   * object (the payload column is JSON and the signature is over its
   * serialization, so a non-object would corrupt both).
   */
  apply(event: string, payload: Record<string, unknown>): Record<string, unknown> {
    let current = payload
    for (const transformer of this.#transformers.values()) {
      const next = transformer.transform(event, current)
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        throw new Error(
          `webhook transformer "${transformer.name}" must return a plain object, got ${
            Array.isArray(next) ? 'an array' : typeof next
          }.`
        )
      }
      current = next
    }
    return current
  }
}
