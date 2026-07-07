import { assertNever } from './assert_never.js'
import { modelName, type ModelName } from './brands.js'
import { isSafeIdentifier } from '../services/isolation/identifier.js'

/**
 * A sensitive capability a plugin DECLARES it needs. It is shown to the operator
 * at install for explicit consent (S1) and cross-checked manifest↔spec by the
 * `check-plugin-permissions` guard, so the disclosure and the code cannot drift.
 *
 * Declaration is DISCLOSURE, not enforcement — the actual containment is layered
 * elsewhere and does not trust this list: an untrusted plugin is routed to a
 * read-only DB connection whether or not it declared `db:write` (S3, Postgres-
 * enforced); egress is contained by the worker's network policy (S4); the
 * `scheduler` / `data_change` seams themselves land in Lote B/C. The value here
 * is an honest, consented install: the operator sees what a plugin intends to do.
 *
 * A discriminated union (never a bare `string[]`) so adding a sensitive
 * capability is a typed, exhaustively-handled change — the serializer's
 * `assertNever` makes an unhandled kind a compile error.
 */
export type PluginPermission =
  | { readonly kind: 'scheduler' }
  | { readonly kind: 'data_change'; readonly models: readonly ModelName[] }
  | { readonly kind: 'network_external' }
  | { readonly kind: 'db_write' }

/** All permission kinds, for docs/tests/exhaustiveness. */
export const PLUGIN_PERMISSION_KINDS = [
  'scheduler',
  'data_change',
  'network_external',
  'db_write',
] as const satisfies ReadonlyArray<PluginPermission['kind']>

const DATA_CHANGE_PREFIX = 'data_change:'

/**
 * Serialize a permission to its canonical manifest wire form (a single string):
 * `scheduler` · `data_change:users,orders` · `network:external` · `db:write`.
 * The ONE place a permission becomes a string, so the wire grammar has a single
 * source. Exhaustive: a new kind without a case here fails to compile.
 */
export function serializePluginPermission(permission: PluginPermission): string {
  switch (permission.kind) {
    case 'scheduler':
      return 'scheduler'
    case 'data_change':
      return `${DATA_CHANGE_PREFIX}${permission.models.join(',')}`
    case 'network_external':
      return 'network:external'
    case 'db_write':
      return 'db:write'
    default:
      return assertNever(permission, 'plugin permission kind')
  }
}

/**
 * Parse a manifest wire string back into a typed permission, or `null` when it
 * is not a recognized permission (the caller drops it with a warning). The
 * inverse of {@link serializePluginPermission}. Hostile / malformed model
 * identifiers in a `data_change:` list invalidate the whole permission rather
 * than being silently trimmed, so a crafted manifest can't smuggle one through.
 */
export function parsePluginPermission(wire: string): PluginPermission | null {
  const value = wire.trim()
  if (value === 'scheduler') return { kind: 'scheduler' }
  if (value === 'network:external') return { kind: 'network_external' }
  if (value === 'db:write') return { kind: 'db_write' }
  if (value.startsWith(DATA_CHANGE_PREFIX)) {
    const raw = value
      .slice(DATA_CHANGE_PREFIX.length)
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0)
    if (raw.length === 0) return null // `data_change` with no models is meaningless
    if (!raw.every((m) => isSafeIdentifier(m))) return null
    return { kind: 'data_change', models: raw.map((m) => modelName(m)) }
  }
  return null
}

/** Serialize a list to wire form, preserving order. */
export function serializePluginPermissions(permissions: readonly PluginPermission[]): string[] {
  return permissions.map(serializePluginPermission)
}

/**
 * Parse a list of wire strings, dropping any unrecognized entry through `onDrop`
 * (so the manifest reader can warn). Mirrors the drop-with-warning contract the
 * rest of `readSatelliteManifest` uses.
 */
export function parsePluginPermissions(
  wire: readonly string[],
  onDrop: (value: string) => void = () => {}
): PluginPermission[] {
  const out: PluginPermission[] = []
  for (const entry of wire) {
    const parsed = parsePluginPermission(entry)
    if (parsed) out.push(parsed)
    else onDrop(entry)
  }
  return out
}

/**
 * Typed builders — the ONLY sanctioned way to populate `definePlugin({
 * permissions })`, so the declared set is always well-formed and stays coherent
 * with the manifest wire form. `dataChange` mints every model through the
 * identifier guard (a hostile model name throws at authoring time). Mirrors the
 * E8 section builders.
 */
export const permission = {
  /** The plugin registers a scheduled tick (Lote B). */
  scheduler: (): PluginPermission => ({ kind: 'scheduler' }),
  /** The plugin subscribes to writes on the named models (Lote C). */
  dataChange: (...models: string[]): PluginPermission => ({
    kind: 'data_change',
    models: models.map((m) => modelName(m)),
  }),
  /** The plugin makes outbound network calls to hosts outside the cluster. */
  networkExternal: (): PluginPermission => ({ kind: 'network_external' }),
  /** The plugin writes to the tenant database (needs operator trust — S3). */
  dbWrite: (): PluginPermission => ({ kind: 'db_write' }),
} as const
