import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  AI_TOOL_ARGS_CANONICAL_MAX_DEPTH,
  AI_TOOL_CONFIRMATION_TOKEN_MAX_LENGTH,
  AI_TOOL_CONFIRMATION_TOKEN_PREFIX,
  MAX_TOOL_CONFIRMATIONS_PER_REQUEST,
  TOOL_CONFIRMATION_TTL_MS,
} from '../constants.js'

/**
 * Human-in-the-loop confirmation for action (mutating) tools.
 *
 * The shape of the whole thing: **the token is the capability, and it carries no
 * claims**. Everything it binds is re-derived from the request being served, and
 * only `jti` and `exp` are ever read off the wire. A claims-style token invites the
 * bug where a field is present but nobody compares it; here there is no field to
 * forget, because a mismatch in tenant, principal, tool name or arguments simply
 * produces a different MAC and nothing verifies.
 *
 * This module is PURE: no store, no container, no HttpContext, no `/services`
 * value-import. It mints and verifies; it does not decide policy and it does not
 * remember anything. At-most-once execution is a separate concern with a separate
 * mechanism (the action ledger) precisely because a bearer token cannot be burned.
 * Statelessness is not replay-safety, and this module does not pretend otherwise.
 *
 * Why stateless at all, given a server-side pending-action record is the obvious
 * alternative: the ledger is needed either way. A stateful design deletes its
 * pending record when it executes (that is what single-use means), so a stream that
 * dies after the effect and before completion leaves no record, the client retries,
 * the model re-proposes, the human re-confirms and the effect fires twice. Once the
 * ledger is there, the pending store buys one saved provider round in exchange for
 * an outage path, a lifetime, a purge target, and downgrading `parseChatBody`'s
 * forge closure from structural to MAC-gated. So: no pending store.
 */

/** Frozen HKDF domain separation (the utils/crypto.ts discipline): a change means a v2 segment, never an edit. */
const MAC_SALT = Buffer.from('lasagna-ai:tool-confirmation:v1:key')
const MAC_INFO = Buffer.from('confirmation-mac-key')

/** Visible ASCII only: a token is an opaque server-minted string, not free text. */
const PRINTABLE_TOKEN = /^[\x21-\x7E]+$/

/**
 * Derive the 32-byte confirmation MAC key from the host's APP_KEY. The third HKDF
 * domain in this package, with salt and info distinct from `idempotency.ts` and the
 * conversation-memory key, so the three can never collide and none is a literal.
 */
export function deriveAiToolConfirmationMacKey(appKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(appKey, 'utf8'), MAC_SALT, MAC_INFO, 32))
}

/**
 * What a confirmation is bound to. Every field is re-derived from the request being
 * served, never read from the presented token.
 *
 * `principalHash` is non-null by construction: an action tool with no resolvable
 * principal is refused before a challenge is ever minted, because a confirmation
 * that binds to nobody is a token any session could spend.
 */
export interface ToolConfirmationBinding {
  readonly tenantId: string
  readonly principalHash: string
  readonly toolName: string
  /** sha256 over the canonicalized VALIDATED arguments (never the raw wire text). */
  readonly argsHash: string
}

/** A freshly minted challenge. */
export interface MintedConfirmation {
  /** The opaque token handed to the client in the confirmation frame. */
  readonly token: string
  /** This mint's nonce. Makes every mint distinct, so one token means one effect. */
  readonly jti: string
  /** Absolute expiry, ms since epoch. */
  readonly expiresAt: number
  /**
   * The token's own MAC, hex. This is the action ledger key AND the idempotency key
   * an action handler receives.
   *
   * It is the TOKEN's MAC and not the binding's hash on purpose. Keying the ledger
   * by `(tenant, principal, tool, args)` would make a LEGITIMATE repeat of the same
   * action (booking the same car again, deliberately) look identical to a replay,
   * and the second one would be silently swallowed. Because every mint carries a
   * fresh `jti`, one token maps to exactly one effect: a conflict on this key can
   * only mean this very token already fired.
   */
  readonly effectKey: string
}

/**
 * Mint a challenge for one proposed action. `now` is injectable so specs pin expiry
 * without sleeping.
 *
 * Wire format: `aitc1.<jti>.<expiresAt>.<mac>`. The `jti` and `exp` travel in the
 * clear because they are inputs to the MAC, so tampering with either changes the
 * expected MAC and the token stops verifying. Nothing else is on the wire: no tenant
 * id, no principal, no tool name, no arguments. A captured token names nothing.
 */
export function mintToolConfirmation(
  macKey: Buffer,
  binding: ToolConfirmationBinding,
  now: number = Date.now()
): MintedConfirmation {
  const jti = randomBytes(16).toString('hex')
  const expiresAt = now + TOOL_CONFIRMATION_TTL_MS
  const mac = computeMac(macKey, binding, jti, expiresAt)
  return {
    token: `${AI_TOOL_CONFIRMATION_TOKEN_PREFIX}.${jti}.${expiresAt}.${mac}`,
    jti,
    expiresAt,
    effectKey: mac,
  }
}

/**
 * Find the presented token that authorizes THIS binding, or null.
 *
 * Recomputes the MAC from the current request's tenant, principal, tool and argument
 * hash, and compares in constant time. A token for another tenant, another
 * principal, another tool, or other arguments does not match, not because a check
 * rejects it but because it is a different value. Expired tokens do not match.
 * Never throws: a caller distinguishes "no confirmation" from "a bad one" by the
 * count of tokens presented, not by an exception, so a malformed token cannot become
 * a 500 on a mutation path.
 */
export function verifyToolConfirmation(
  macKey: Buffer,
  presented: readonly string[],
  binding: ToolConfirmationBinding,
  now: number = Date.now()
): MintedConfirmation | null {
  for (const token of presented) {
    const parsed = parseToken(token)
    if (!parsed) continue
    if (parsed.expiresAt <= now) continue
    const expected = computeMac(macKey, binding, parsed.jti, parsed.expiresAt)
    if (!macEquals(expected, parsed.mac)) continue
    return {
      token,
      jti: parsed.jti,
      expiresAt: parsed.expiresAt,
      effectKey: parsed.mac,
    }
  }
  return null
}

/**
 * Read the confirmation header into a bounded list of candidate tokens. Malformed or
 * oversized entries are DROPPED rather than rejected: presenting a stale token beside
 * a good one is normal client behaviour across a multi-step conversation, and failing
 * the whole request for it would turn a cosmetic client bug into a dead mutation path.
 * A token that is dropped simply does not authorize anything, which is the same
 * outcome as not sending it.
 */
export function parseToolConfirmationHeader(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return []
  const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => value.split(','))
  const out: string[] = []
  for (const part of parts) {
    const token = part.trim()
    if (token.length === 0 || token.length > AI_TOOL_CONFIRMATION_TOKEN_MAX_LENGTH) continue
    if (!PRINTABLE_TOKEN.test(token)) continue
    out.push(token)
    if (out.length >= MAX_TOOL_CONFIRMATIONS_PER_REQUEST) break
  }
  return out
}

/**
 * A stable string for a validated argument object, so the same arguments always hash
 * the same way.
 *
 * This is load-bearing, not housekeeping. The model re-proposes the action on the
 * confirming turn, and JSON key order is not guaranteed to survive that round trip.
 * If `{a:1,b:2}` and `{b:2,a:1}` hashed differently, confirmation would fail at
 * random and the feature would read as broken. So object keys are sorted; arrays keep
 * their order, since order is meaning there. Depth is bounded: the input has already
 * been through `validateToolInput`, but this must not be the place a hostile shape
 * can hang the single pump.
 */
export function canonicalizeToolArgs(value: unknown, depth: number = 0): string {
  if (depth > AI_TOOL_ARGS_CANONICAL_MAX_DEPTH) return '"__depth__"'
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null'
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeToolArgs(item, depth + 1)).join(',')}]`
  }
  if (typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeToolArgs(
            (value as Record<string, unknown>)[key],
            depth + 1
          )}`
      )
    return `{${entries.join(',')}}`
  }
  // A function, symbol or bigint cannot come out of validateToolInput; if one ever
  // did, hashing it as a constant is the safe direction (it cannot match a token).
  return '"__unsupported__"'
}

/** sha256 of the canonicalized arguments, hex. */
export function hashToolArgs(args: Record<string, unknown>): string {
  return createHmac('sha256', EMPTY_KEY).update(canonicalizeToolArgs(args)).digest('hex')
}

/**
 * A keyless HMAC is just a hash with extra steps, but reusing `createHmac` keeps this
 * module to one primitive. The value is never a secret: it is an equality tag over
 * arguments that the MAC then binds under the real key.
 */
const EMPTY_KEY = Buffer.alloc(32)

/** `aitc1.<jti>.<exp>.<mac>` split into its parts, or null when it is not that. */
function parseToken(token: string): { jti: string; expiresAt: number; mac: string } | null {
  if (token.length > AI_TOOL_CONFIRMATION_TOKEN_MAX_LENGTH) return null
  const parts = token.split('.')
  if (parts.length !== 4) return null
  const [prefix, jti, exp, mac] = parts as [string, string, string, string]
  if (prefix !== AI_TOOL_CONFIRMATION_TOKEN_PREFIX) return null
  if (jti.length === 0 || mac.length === 0) return null
  if (!/^\d+$/.test(exp)) return null
  const expiresAt = Number(exp)
  if (!Number.isSafeInteger(expiresAt)) return null
  return { jti, expiresAt, mac }
}

/** The MAC over everything the confirmation binds. Newline-separated: no field can run into the next. */
function computeMac(
  macKey: Buffer,
  binding: ToolConfirmationBinding,
  jti: string,
  expiresAt: number
): string {
  return createHmac('sha256', macKey)
    .update(
      `${binding.tenantId}\n${binding.principalHash}\n${binding.toolName}\n${binding.argsHash}\n${jti}\n${expiresAt}`
    )
    .digest('hex')
}

/** Constant-time hex compare that cannot throw on a length mismatch. */
function macEquals(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
