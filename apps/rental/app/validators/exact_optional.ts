/**
 * Bridges VineJS schemas onto TypeScript's `exactOptionalPropertyTypes: true`.
 *
 * VineJS 4.x models `.optional()` / `.nullable()` fields with modifiers whose
 * `allowNull` / `isOptional` getters are typed `boolean | undefined`, while
 * VineJS's own `ConstructableSchema` declares them `boolean?`. Under
 * `exactOptionalPropertyTypes` an optional property may be absent but not
 * `undefined`, so every optional field trips TS2375. These aliases re-type only
 * those three members back to what the runtime actually guarantees; the
 * `[OTYPE]` inference marker is preserved, so `Infer<...>` stays exact.
 *
 * Usage:
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
