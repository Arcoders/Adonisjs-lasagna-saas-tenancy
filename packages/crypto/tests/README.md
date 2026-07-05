# crypto test tree

Tests are organised by **guarantee** (what the system promises), not by mechanism.
The harness (unit vs integration) is the leaf inside each guarantee, so a runner
still selects only the specs it can run.

```
tests/
  @guarantees/<g>/{unit,integration}/   g = isolation | security | behavior | resilience | performance
  @architecture/{boundaries,contracts,docs}/   static guards (unit harness)
  @integration/drivers/                 gating stack tier
  helpers/                              shared, non-spec support
```

unit specs run against source with tsx and no database; integration specs boot
the shared Ignitor and PostgreSQL. Every package ships the same skeleton so the
layout reads the same everywhere; empty slots carry a README until specs arrive.
The chaos tier (`@integration/fault_injection`) and the fixture app
(`tests/fixtures`) live only in core.

Name guarantee specs `<guarantee>_<context>_<outcome>.spec.ts`. The
`@architecture/boundaries/<pkg>_guarantee_tree` spec calls the kit's
`assertGuaranteeTree`, so this layout is pinned against the single-sourced
taxonomy and cannot drift unnoticed.

## Threat coverage (T1..T14 → where it is proved)

The design's threat table (`design/data-protection-satellites/01-crypto.md` §3) maps each
`Tn` to an invariant `In`. This is where each vector is enforced/proved, so coverage can be
audited without reading every spec.

| # | Vector | Enforced / proved by |
|---|---|---|
| T1 | Steal the DB at rest | `crypto_invariant_1_no_plaintext_sibling` + `behavior_crypto_service` (fields are enc_v2) |
| T2 | Steal DB + wrapped-DEK table | `crypto_invariant_2_wrapped_dek_allowlist` (DEK only wrapped; honest env limit in §10) |
| T3 | Brute-force the search index | `security_blind_index_keyed_hmac` + `crypto_invariant_5_blind_index` (keyed HMAC) |
| T4 | Read equality/frequency | `security_blind_index_keyed_hmac` (documented I5 leak asserted) |
| T5 | Write cleartext to an encrypted field | `behavior_encrypted_column_check` + `crypto_invariant_3_fail_closed` (DB CHECK) |
| T6 | Read a non-ciphertext as usable | `crypto_invariant_3_fail_closed` + `resilience_keyprovider_kms_down` (strict open) |
| T7 | Confused-deputy across classes | `crypto_invariant_4_domain_separation` + `behavior_crypto_service` (per-DEK keying) |
| T8 | Recover shredded data | `resilience_shred_makes_ciphertext_inert*` + `crypto_invariant_6_shred_scaffold` |
| T9 | Erase records the law keeps | `security_shred_legal_hold_refused` + `security_shred_governance_absent_refused` (+ `_real_pg`) + `crypto_invariant_7` |
| T10 | KEK rotation bricks data | `resilience_rekek_rewrap_real_pg` + `behavior_rekek_accounting` + `crypto_invariant_8` |
| T11 | Leak a key via log/error | `crypto_invariant_9_no_key_in_logs` |
| T12 | Race two DEK writes | `crypto_invariant_10_partial_unique` + `resilience_shred_concurrent_race` (authority) |
| T13 | Point a KeyProvider at an internal URL | `security_keyprovider_ssrf_blocked` + `crypto_invariant_11_ssrf` (safeFetch pin) |
| T14 | Stale blind index after a shred | documented honest limit (I5, §10); `@searchable` JSDoc + `SubjectShredded` host write path |

The two-phase WORM audit (§6.6) is proved by `security_shred_gated` (unit) and
`resilience_shred_committed_mark_fails_real_pg` (real-PG crash reconciliation); the framed
enc_v2 stream envelope (§6.8) by `resilience_framed_stream_envelope`.
