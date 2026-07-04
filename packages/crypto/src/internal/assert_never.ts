/**
 * Exhaustiveness helper: a `switch` over a closed union routes its `default` here
 * so a newly added variant is a COMPILE error (the argument stops being `never`),
 * not a silent fallthrough. Mirrors the AI satellite's `assertNever`.
 */
export function assertNever(value: never, label: string): never {
  throw new Error(`Unhandled ${label}: ${String(value)}`)
}
