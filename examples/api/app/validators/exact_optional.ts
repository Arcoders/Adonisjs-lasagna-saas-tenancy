/**
 * Bridges VineJS schemas onto TypeScript's `exactOptionalPropertyTypes: true`.
 *
 * VineJS 4.x models `.optional()` / `.nullable()` fields with `OptionalModifier`
 * / `NullableModifier`, whose `allowNull` and `isOptional` members are getters
 * typed `boolean | undefined`. VineJS's own `ConstructableSchema` interface (the
 * shape every `vine.object({...})` property is checked against) declares those
 * same members as `allowNull?: boolean` / `isOptional?: boolean`. Under
 * `exactOptionalPropertyTypes` an optional property may be absent but its value
 * may not be `undefined`, so the getter's `| undefined` is rejected and every
 * optional/nullable field trips TS2375. The incompatibility also reaches through
 * `clone(): this`, so re-typing the two flags alone is not enough.
 *
 * These aliases re-type only those three members back to what the runtime
 * actually guarantees. Nothing else is touched: the `[OTYPE]` marker VineJS uses
 * to infer a validator's output type is preserved verbatim, so `Infer<...>` and
 * every downstream payload type stay exact (a wrong field type is still a
 * compile error). The cast is purely a compile-time bridge; `vine.object`
 * receives the identical object at runtime.
 *
 * To use it, name the schema map and cast it with its own `typeof`:
 *
 * ```ts
 * const schema = { title: vine.string(), body: vine.string().optional() }
 * export const createFooValidator = vine.compile(
 *   vine.object(schema as ExactOptionalProps<typeof schema>)
 * )
 * ```
 */
export type ExactOptionalSchema<T> = Omit<T, 'allowNull' | 'isOptional' | 'clone'> & {
  allowNull?: boolean
  isOptional?: boolean
  clone(): ExactOptionalSchema<T>
}

/** Applies {@link ExactOptionalSchema} across every property of a `vine.object` map. */
export type ExactOptionalProps<P> = {
  [K in keyof P]: ExactOptionalSchema<P[K]>
}
