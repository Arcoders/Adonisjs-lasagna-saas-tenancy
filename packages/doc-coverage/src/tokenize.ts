/**
 * The D2-soft tokenizer (RFC §8). Splits identifiers on camelCase / snake_case /
 * non-alphanumeric boundaries, lowercases, and drops noise. The output is an
 * exact token set, never a percentage. A param stoplist and a synonyms map keep
 * the false-missing rate down. Both were calibrated against the Step-0 spike,
 * where `opts` (generic param) and `assigned`/`clear` (morphological variants)
 * were the only false-missings against `docs/guides/satellites/quotas.md`.
 */

/**
 * Generic parameter names that carry no documentation signal. A doc that never
 * spells out `opts` is not stale, so these never count as a missing token.
 */
export const PARAM_STOPLIST: ReadonlySet<string> = new Set([
  'opts',
  'options',
  'cb',
  'fn',
  'args',
  'arg',
  'ctx',
  'context',
  'params',
  'param',
  'data',
  'payload',
  'input',
  'value',
  'val',
  'obj',
  'item',
  'items',
  'self',
  'that',
  'res',
  'req',
  // Generic parameter fragments surfaced by the first full repo run: time/index
  // helpers, error vars, db-internal names, and billing parameter words that a
  // narrative doc is not expected to spell out at the parameter level.
  'allowed',
  'amount',
  'bytes',
  'capability',
  'code',
  'conn',
  'count',
  'created',
  'days',
  'dest',
  'destination',
  'driver',
  'err',
  'error',
  'event',
  'file',
  'ids',
  'idx',
  'issuer',
  'local',
  'name',
  'new',
  'now',
  'price',
  'quantity',
  'resolver',
  'runner',
  'session',
  'source',
  'state',
  'sub',
  'tables',
  'threshold',
  'trx',
])

/**
 * Generic method-name fragments that carry no documentation signal. The D2-soft
 * vocabulary includes a symbol's member names, but CRUD / lifecycle / framework
 * verbs (`get`, `clear`, `list`, a middleware `handle`) and internal helpers are
 * not something a narrative doc should be expected to enumerate. This is the
 * member-name counterpart of `PARAM_STOPLIST`, applied per token after a member
 * name is split. Domain-meaningful method words (meter, sync, verify, discover,
 * recompute, ...) are deliberately NOT here, so a real capability gap still
 * surfaces. Calibrated against the first full repo run (213 tokens triaged).
 */
export const MEMBER_TOKEN_STOPLIST: ReadonlySet<string> = new Set([
  'access',
  'after',
  'assert',
  'bind',
  'bucket',
  'build',
  'cache',
  'callback',
  'capacity',
  'circuit',
  'clear',
  'client',
  'column',
  'copy',
  'counts',
  'create',
  'data',
  'declarative',
  'destroy',
  'dispatch',
  'download',
  'emit',
  'ensure',
  'evict',
  'extract',
  'failure',
  'fatal',
  'get',
  'handle',
  'has',
  'increment',
  'integer',
  'iterate',
  'leave',
  'list',
  'load',
  'locked',
  'log',
  'meta',
  'minute',
  'misconfigured',
  'monthly',
  'names',
  'namespace',
  'persist',
  'persisted',
  'rejection',
  'release',
  'report',
  'restore',
  'retrieve',
  'run',
  'save',
  'scoped',
  'sequences',
  'short',
  'supports',
  'temp',
  'token',
  'tokens',
  'unregister',
  'upload',
  'url',
  'where',
])

/** Tokens shorter than this are dropped (de, id, to, of, …): too noisy to match on. */
const MIN_TOKEN_LENGTH = 3

/**
 * Split a string into lowercase word tokens. `getAssignedPlan` becomes
 * {get, assigned, plan}; `max_tokens` becomes {max, tokens}.
 */
export function tokenize(input: string): string[] {
  return (
    (
      input
        // camelCase / PascalCase boundary
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        // acronym to word boundary: HTTPServer -> HTTP Server
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .replace(/[_-]/g, ' ')
        .toLowerCase()
        .match(/[a-z][a-z0-9]*/g) ?? []
    ).filter((t) => t.length >= MIN_TOKEN_LENGTH)
  )
}

/** A unique, order-stable token set from a body of text. */
export function tokenSet(input: string): Set<string> {
  return new Set(tokenize(input))
}

export type SynonymMap = Record<string, string[]>

/**
 * Expand a token set with its declared synonyms so a near-match is not a
 * false-missing. `doc-synonyms.json` is `{ canonical: [alias, …] }`; both
 * directions are added so `assign` in prose satisfies a contract token
 * `assigned` and vice-versa.
 */
export function withSynonyms(tokens: Set<string>, synonyms: SynonymMap): Set<string> {
  if (!synonyms || Object.keys(synonyms).length === 0) return tokens
  const out = new Set(tokens)
  for (const [canonical, aliases] of Object.entries(synonyms)) {
    const group = [canonical, ...aliases].map((s) => s.toLowerCase())
    if (group.some((g) => out.has(g))) for (const g of group) out.add(g)
  }
  return out
}

export interface TokenDiff {
  present: string[]
  missing: string[]
}

/**
 * The contract-vs-prose token diff. `contractTokens` are the symbol's param and
 * method names (already stoplist-filtered upstream); `proseTokens` is the linked
 * doc's token set, optionally synonym-expanded. Returns the exact split, sorted.
 */
export function diffTokens(contractTokens: Set<string>, proseTokens: Set<string>): TokenDiff {
  const present: string[] = []
  const missing: string[] = []
  for (const t of contractTokens) (proseTokens.has(t) ? present : missing).push(t)
  present.sort()
  missing.sort()
  return { present, missing }
}
