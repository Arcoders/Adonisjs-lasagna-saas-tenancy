import { assertContractCompat } from '../sdk/contract_version.js'
import ExtensionCollisionException from '../exceptions/extension_collision_exception.js'

/**
 * Shared base for the family of single-source extension registries: resolver,
 * isolation driver, authorizer, tenant middleware, audit destination, webhook
 * transformer, feature-flag strategy, bootstrapper. It owns the backing Map and
 * the `has` / `unregister` / `clear` / `contractVersion` surface, and it owns the
 * ONE registration gate every one of them ran by hand:
 *
 *   1. the entry key is a non-empty string;
 *   2. a duplicate key is refused (fail loud, never silently shadow the first
 *      registration) unless `{ override: true }`;
 *   3. {@link assertShape} runs UNCONDITIONALLY (EXT-2): a boot-time shape gate
 *      INDEPENDENT of the version comparison, so an entry missing a required member
 *      throws at `register()` instead of registering and crashing mid-request;
 *   4. {@link assertContractCompat} gates the declared contract version, skipped
 *      for an unversioned surface (`surfaceContractVersion` left `undefined`).
 *
 * A subclass declares {@link surfaceLabel}, optionally overrides
 * {@link surfaceContractVersion} (a versioned surface), {@link assertShape} (a
 * required-member gate), and {@link collisionError} (a domain-specific exception).
 * It keeps its own public `register()`, because the signatures genuinely diverge
 * (`{ activate }`, a `providerName`, a value transform): it calls
 * {@link assertRegistrable} for the gate and then stores into {@link entries} plus
 * whatever side effect it owns (activation, LIFO order). Everything past the gate
 * (chain ordering, the trust gate, LIFO teardown, `resolveSync`) stays in the
 * subclass, where it belongs.
 *
 * `TStored` is what the Map holds; `TEntry` is what `register()` accepts, which
 * differs only when a surface stores a derived value (capability registers a
 * `CapabilityProvision` but stores a `StoredCapability`). They coincide by default.
 */
export default abstract class ExtensionRegistry<TName extends string, TStored, TEntry = TStored> {
  /** The single source of truth. Subclasses store into it and read from it. */
  protected readonly entries = new Map<TName, TStored>()

  /** Human label used in the default plumbing/collision messages. */
  protected abstract readonly surfaceLabel: string

  /** The contract version this surface enforces, or `undefined` when unversioned. */
  protected get surfaceContractVersion(): number | undefined {
    return undefined
  }

  /** The declared contract version an entry carries. Default: `entry.contractVersion`. */
  protected entryVersion(entry: TEntry): number | undefined {
    return (entry as { contractVersion?: number }).contractVersion
  }

  /** An entry's unique key. Default: `entry.name`. */
  protected keyOf(entry: TEntry): TName {
    return (entry as { name: TName }).name
  }

  /**
   * Validate an entry's SHAPE, UNCONDITIONALLY (EXT-2). Default: no-op. Override to
   * throw when a required member is missing, so a shape violation fails at boot,
   * not warn-then-crash mid-request. Runs INDEPENDENT of the version comparison, so
   * a v1, unversioned, or too-old-declared entry is checked all the same.
   */
  protected assertShape(_entry: TEntry): void {}

  /**
   * Remediation appended to the default collision message. Empty by default; a registry
   * that accepts `{ override: true }` sets it so the error tells the caller how to replace
   * the existing entry instead of just reporting the conflict.
   */
  protected readonly collisionHint: string = ''

  /** The error thrown on a duplicate key. Override for a domain-specific exception. */
  protected collisionError(name: TName): Error {
    return new ExtensionCollisionException(
      `${this.surfaceLabel} "${name}" is already registered.${this.collisionHint}`,
      { plugin: name }
    )
  }

  /**
   * Run the four uniform checks (name, collision, shape, version, in that order)
   * and return the validated key. Does NOT store: the subclass's `register()` stores
   * (and wires any side effect or value transform), so a registry that keeps extra
   * state runs the exact same gate without contorting its storage into this base.
   */
  protected assertRegistrable(entry: TEntry, opts: { override?: boolean } = {}): TName {
    const name = this.keyOf(entry)
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`${this.surfaceLabel} registration: name must be a non-empty string.`)
    }
    if (this.entries.has(name) && opts.override !== true) {
      throw this.collisionError(name)
    }
    this.assertShape(entry)
    const version = this.surfaceContractVersion
    if (version !== undefined) {
      assertContractCompat(this.entryVersion(entry), version, `${this.surfaceLabel} "${name}"`)
    }
    return name
  }

  /** The contract version this surface implements (`undefined` when unversioned). */
  get contractVersion(): number | undefined {
    return this.surfaceContractVersion
  }

  has(name: TName): boolean {
    return this.entries.has(name)
  }

  unregister(name: TName): boolean {
    return this.entries.delete(name)
  }

  clear(): this {
    this.entries.clear()
    return this
  }
}
