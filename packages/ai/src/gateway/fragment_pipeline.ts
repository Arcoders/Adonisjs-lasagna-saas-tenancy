import type { StreamFragment } from '../types/ai_provider_contract.js'

/**
 * The per-fragment stage of the streaming pump, kept separate from the socket
 * and the quota so it unit-tests without either: it validates a fragment (the
 * output-bound guard), rejects a negative or non-finite token count, and tracks the running
 * token total and fragment count. The cumulative total is what the service hands
 * to `settle` (which clamps it to the reservation worst case) and what the budget
 * early-stop compares against, so the clamp itself lives in one place (the quota
 * seam), not here.
 */
export default class FragmentPipeline {
  #cumulative = 0
  #count = 0

  constructor(
    private readonly validate: (fragment: StreamFragment) => StreamFragment | null,
    private readonly worstCase: number
  ) {}

  /**
   * Run the output-bound validator and the token-sanity check. Returns the accepted
   * fragment, or null to abort the stream (a leaking fragment or a bad token
   * count is never written).
   */
  admit(fragment: StreamFragment): StreamFragment | null {
    const validated = this.validate(fragment)
    if (validated === null) return null
    if (!Number.isFinite(validated.tokens) || validated.tokens < 0) return null
    return validated
  }

  /** Record a written fragment's tokens toward the running total. */
  account(fragment: StreamFragment): void {
    this.#count += 1
    this.#cumulative += fragment.tokens
  }

  get cumulative(): number {
    return this.#cumulative
  }

  get count(): number {
    return this.#count
  }

  /** Whether reported usage has reached the worst-case hold (the budget early-stop trip). */
  get budgetExhausted(): boolean {
    return this.#cumulative >= this.worstCase
  }
}
