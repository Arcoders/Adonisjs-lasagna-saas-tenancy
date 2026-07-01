/**
 * Exhaustiveness helper for closed tagged unions. Call it in the `default` arm
 * of a switch over a discriminated union (or the fall-through of an if-chain) so
 * that adding a new variant without handling it is a COMPILE error, not a silent
 * runtime leak. If control ever reaches it at runtime (an unchecked cast), it
 * throws loudly rather than returning undefined.
 */
export function assertNever(value: never, context = 'value'): never {
  throw new Error(`[ai] unexpected ${context}: ${String(value)}`)
}
