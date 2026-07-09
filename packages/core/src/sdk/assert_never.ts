/**
 * Exhaustiveness helper for the plugin surface's closed discriminated unions.
 *
 * Call it in the `default:` branch of a `switch (entry.kind)` so that adding a
 * new section `kind` without handling it becomes a COMPILE error (the argument
 * stops being assignable to `never`). At runtime it throws, a defense-in-depth
 * backstop for a value that somehow arrives un-narrowed (e.g. across a JSON
 * boundary). Paired with `noFallthroughCasesInSwitch` (E1) so a missing `break`
 * cannot silently reach the wrong arm either.
 */
export function assertNever(value: never, context: string = 'value'): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(value)}`)
}
