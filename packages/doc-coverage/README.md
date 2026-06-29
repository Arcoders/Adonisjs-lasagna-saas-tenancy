# @adonisjs-lasagna/doc-coverage

Dev-only, private, never published. The deterministic documentation-drift engine
behind `npm run docs:doctor`. Zero LLM, zero network, zero secret.

It builds a bidirectional code-to-docs graph from the monorepo's `exports` maps
and the `docs/` tree, then reports:

- **Coverage** of public symbols (explained / exemplified-only / uncovered).
- **D1** type-checked fences as documentation edges.
- **D2** JSDoc-to-prose alignment (a gate-able dead-member check plus an advisory
  token-set diff).
- **D3** contract-hash freshness (a page older than the symbol's signature).
- **D4** one-hop static reachability of a changed symbol.

Only the deterministic Tier-1 gate can block; the Tier-2 report only informs.

## Run it

```
npm run docs:doctor                      # full report on the whole repo
npm run docs:doctor -- --since <ref>     # impact report for a git range
npm run docs:doctor -- --json            # machine-readable
npm run docs:doctor -- --explain <name>  # why a symbol is/ is not documented
npm run docs:doctor -- --init-anchors    # propose front-matter code: anchors
```

The design contract is the RFC at `docs/dev/doc-coverage-rfc.md`. The public
learning page is `docs/guides/documentation-coverage.md`. The gate wrapper is
`scripts/check-doc-coverage.mjs`.

## Tuning D2-soft noise

The advisory token-set diff (D2-soft) treats a symbol's method and parameter
names as its vocabulary. Two levers keep the false-missing rate down, both meant
to be edited as new code lands:

- **Stoplists** in `src/tokenize.ts`. `MEMBER_TOKEN_STOPLIST` drops structural
  method words (`get`, `clear`, `list`, a middleware `handle`); `PARAM_STOPLIST`
  drops generic parameter names. Add a token here only if it is genuinely
  structural; domain words (`meter`, `sync`, `verify`) must stay, so a real
  capability gap still surfaces.
- **`doc-synonyms.json`** at the repo root, shape `{ "canonical": ["alias", …] }`,
  where the *canonical* is the contract token the diff reports and each *alias* is
  the word the prose actually uses. The match expands both directions, so
  `{"assigned": ["assign"]}` means prose saying "assign" satisfies a contract
  token `assigned` and vice versa. Add an entry when a doc covers a concept under
  a real word variant; prefer writing the missing prose over a synonym when the
  concept is genuinely absent.

## Tests

```
npm run test --workspace @adonisjs-lasagna/doc-coverage
```

Property tests cover the contract hash (comment-immune, signature-sensitive,
path-free) and the tokenizer; a golden fixture under `tests/fixtures/mini`
exercises barrel resolution, coverage classification, edge provenance, and the
dead-member gate.
