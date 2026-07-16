---
title: AI security & threat model
description: The AI satellite's consolidated threat model — 18 vectors mapped to their mitigation, the eight structural invariants, the fail-closed postures, the honest residual limits, and a production hardening checklist.
---

# AI security & threat model

This page is the consolidated threat model for `@adonisjs-lasagna/ai`. The
[AI satellite guide](/guides/satellites/ai) is the how-to (config, routes,
features); this page is the security posture behind it: the 18 threat vectors an
AI feature adds to a multi-tenant SaaS, how the satellite closes each one, the
eight invariants that make the guarantees structural, the postures you opt into,
and the residual risks stated plainly.

The organising idea is that **isolation is structural, not detected**. The
satellite does not try to spot a prompt-injection payload or scan a response for
another tenant's data. It makes cross-tenant leakage impossible by construction:
the model's context is tenant-pure (invariant **I4**), so a successful injection
has nothing foreign to retrieve, and every store is physically tenant-scoped
(**I1**). The mitigations below reinforce that boundary; they are not a filter in
front of a shared pool.

## The threat model: 18 vectors

Every vector below maps to a red-first covering spec in the test suite. The
mapping is pinned by an anti-drift matrix
([ai_threat_vector_coverage_matrix.spec.ts](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@architecture/docs/ai_threat_vector_coverage_matrix.spec.ts)),
so renaming or deleting a covering spec without updating the matrix is a hard CI
failure. The "Proof" link is the spec that exploits the vector and asserts the
mitigation holds.

| # | Vector | How the satellite closes it | Invariant | Proof |
|---|---|---|---|---|
| 1 | Memory injection / persistent contamination | Per-(tenant, user) session HMAC; memory replayed as `user`/`assistant` data, never a system directive; turn and char caps; enc_v2 at rest | I2 | [session isolation](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_memory_session_isolation.spec.ts) |
| 2 | Prompt-size denial of service | Plan-aware rate limiter (fail-closed) + cost reservation cap; `maxPromptChars` / `maxTokens` / `maxTurns` input bounds | — | [preflight statuses](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/behavior/unit/behavior_chat_controller_preflight_statuses.spec.ts) |
| 3 | Embedding injection / index poisoning | Ingestion gated by `authorizeIngestion`; provenance (source, actor) per row; rollback-by-source; per-tenant isolation bounds the blast radius | I1 | [vector store](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_vector_store.spec.ts) |
| 4 | BYOK key exploitation | Per-tenant **and** per-key rate limit; cost governor caps spend; audit records the key fingerprint, never the key; rotation via `tenant:secrets:reencrypt` | I6 | [per-key rate limit](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_rate_limit_byok_per_key.spec.ts) |
| 5 | Token / response replay | Response cache namespaced by tenant + user + session + short TTL; idempotency scope is an HMAC, so no component appears in a cache key | I3 | [idempotency scope](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_idempotency_key_hmac_scoped.spec.ts) |
| 6 | Audit tampering | DB triggers reject `UPDATE`/`DELETE`/`TRUNCATE` for every role + a per-tenant `seq`+`checksum` hash chain + optional external WORM/SIEM anchoring | I5 | [chain checksum](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_ai_audit_chain_checksum.spec.ts) |
| 7 | Cross-provider context poisoning | Context built per (tenant, user, session), never shared across providers; audit records which provider saw which data; per-tenant residency allow-list | I4 | [residency gate](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_residency_gate.spec.ts) |
| 8 | Streaming exfiltration | Bounded output + per-chunk validation, abort via `AbortSignal`, plus an optional host `redactOutput` DLP seam (defense-in-depth); by I4 nothing cross-tenant is in context, so this guards prompt-leak and bounds, not isolation | I4, I8 | [output bound](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@architecture/boundaries/ai_invariant_8_output_bound.spec.ts) |
| 9 | Hallucination "exfiltration" | Grounding in retrieved sources; a quality control, not isolation. Cross-tenant leakage is 0 by construction (see [Honest limits](#honest-limits)) | — | [RAG context integrity](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_chat_rag_context_integrity.spec.ts) |
| 10 | Indirect prompt injection via RAG content | Retrieved content is untrusted **data, not instructions** (role + fenced delimiter); harmless because foreign data is never in context (I4) | I4 | [RAG context integrity](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_chat_rag_context_integrity.spec.ts) |
| 11 | SSRF via AI-initiated fetch or BYOK endpoint | Every AI-initiated URL and the BYOK endpoint pass the kernel's `safeFetch`, which pins the validated IP for the connection (no DNS rebind) and refuses redirects (no 302 bypass), and blocks loopback / RFC-1918 / CGN / metadata / IPv6 transition | — | [ingestion SSRF](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/behavior/unit/behavior_embedding_ingestion.spec.ts) |
| 12 | Tool / agent confused-deputy | Tools run inside `tenancy.run()` behind a default-deny registry and a per-tool `authorizeTool` hook; the executor re-asserts the ambient tenancy scope *before* binding, so a call arriving under another tenant's scope is refused rather than served; arguments are whitelist-reconstructed, results are fenced `tool`-role data, and every call is audited `op: 'tool'`. Action (mutating) tools stay off behind a kill-switch | I7 | [tool gate](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/behavior/unit/behavior_tool_gate.spec.ts) |
| 13 | Cost amplification / denial-of-wallet | Reserve/settle across the whole run + a per-request token cap + an operator-global ceiling so one tenant cannot bankrupt a shared managed account | I3 | [budget posture](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/behavior/unit/behavior_ai_budget_posture.spec.ts) |
| 14 | Audit log as a sensitive-data store | Audit stores only non-PII metadata (counts, ids, model, one-way hashes); GDPR erasure never has to chase content into the immutable log | I5, G1 | [non-PII row](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_ai_audit_persisted_row_non_pii.spec.ts) |
| 15 | PII to provider / training | Residency allow-list (`local-only`); a `check-ai-no-prompt-logging-for-training` guard keeps prompts/responses/documents/memory out of application logs | — | [residency gate](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_residency_gate.spec.ts) |
| 16 | Embedding sensitivity / inversion | An embedding inverts to its source text, so it is treated as sensitive content: per-tenant physical isolation (I1) + purge deletes embeddings and memory | I1 | [two-tenant no leak](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/isolation/integration/isolation_vector_store_two_tenant_no_leak.spec.ts) |
| 17 | Cross-tenant existence disclosure / side channel | Uniform error responses, no "tenant X not found"; `timingSafeEqual` on the security-sensitive comparisons | — | [uniform error](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_ai_uniform_error_no_existence_disclosure.spec.ts) |
| 18 | Vector-store resource exhaustion | A per-plan `embeddingCount` quota enforced atomically (advisory-locked count + insert) before the write; per-tenant limits | I1 | [reserve fail-closed](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/ai/tests/@guarantees/security/unit/security_embedding_reserve_failclosed.spec.ts) |

Vectors 9 and 17 carry no chaos/fault spec by design, each for a stated reason:
hallucination is a quality property not an isolation fault, and a uniform 403 is a
deterministic property asserted by its red spec rather than a fault to inject. Those
reasons are recorded in the coverage matrix so the gap is auditable, not silent.

## The eight invariants

The vectors above lean on eight invariants. An invariant is a property the
satellite holds structurally, and where one can be pinned by a source scan, a
`check-ai-invariant-*` guard fails the build if a change breaks it.

| # | Invariant | What it guarantees | Pinned by |
|---|---|---|---|
| **I1** | Vector indices are physically tenant-scoped | The store never hardcodes a location; it asks the active isolation driver `tableLocation(tenant)` where the tenant's embeddings live. Logical (`rowscope-pg`) placement is refused for inversion-sensitive data | [`check-ai-invariant-1`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/scripts/check-ai-invariant-1.mjs) |
| **I2** | Conversation memory is encrypted at rest, tenant-bound, TTL-bounded | enc_v2 with its own secret class; sessions are HMAC-bound to (tenant, principal) and replayed as data, never a system directive | [`check-ai-invariant-2`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/scripts/check-ai-invariant-2.mjs) |
| **I3** | The cost governor is fail-closed | No provider call proceeds without an atomic reservation; actuals settle per chunk; over-budget is a hard stop with no estimate-only bypass | Runtime reserve/settle (no source-scan guard) |
| **I4** | The model's context is tenant-pure | The system prompt carries no other tenant's data; RAG retrieval is tenant-scoped. Prompt injection is harmless by isolation, not "detected" | [`check-ai-invariant-4`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/scripts/check-ai-invariant-4.mjs) |
| **I5** | Every op is append-only audited with attribution | Immutability at the DB level (`BEFORE UPDATE`/`DELETE`/`TRUNCATE` triggers) + a per-tenant `seq`+`checksum` chain; non-PII metadata only | [`check-ai-invariant-5`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/scripts/check-ai-invariant-5.mjs) |
| **I6** | Provider credentials are per-tenant, encrypted, never logged | BYOK keys live encrypted; the key never appears in a prompt, error, metric or span; rotation reuses `tenant:secrets:reencrypt` | Secret-crypto discipline (no AI-specific guard) |
| **I7** | Tool / function calling is tenant-scoped and least-privilege | A tool runs inside the active `tenancy.run()` scope behind a default-deny registry, with the ambient scope re-asserted before the bind and a per-tool authorization hook that denies unless the host wires it. Mutating tools are refused outright until explicitly enabled | [`check-ai-invariant-7`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/scripts/check-ai-invariant-7.mjs) |
| **I8** | Output is bounded and the system prompt never leaks | Every streamed response path applies an output bound; the system prompt is never disclosed in an error or log | [`check-ai-invariant-8`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/scripts/check-ai-invariant-8.mjs) |

## OWASP LLM Top 10 (2025) coverage

The 18 vectors above are Lasagna's own taxonomy. This table crosswalks them to the
industry-standard [OWASP Top 10 for LLM Applications (2025)](https://genai.owasp.org/),
so a security review can map its checklist onto what the satellite enforces. The
posture is stated honestly per row: some categories are closed by construction, and a
couple carry documented residuals in [Honest limits](#honest-limits).

| OWASP (2025) | Vectors | Invariant(s) | How the satellite addresses it |
|---|---|---|---|
| **LLM01** Prompt Injection | #1, #10 | I4, I2 | Retrieved and memory content is fenced `user`-role data, never a system directive; injection is harmless by isolation, not "detected". |
| **LLM02** Sensitive Information Disclosure | #14, #15, #17 | I5, I6 | Non-PII hash-chained audit; a `residency` egress allow-list plus a no-prompt-logging guard; uniform errors; the optional `redactOutput` output DLP seam. |
| **LLM03** Supply Chain | provider trust | I6 | No model artifacts are loaded (providers are remote APIs); per-tenant encrypted BYOK keys; SSRF-pinned egress. Provider-SDK trust is a stated residual. |
| **LLM04** Data & Model Poisoning | #3 | I1 | Ingestion is authorized with per-row provenance (source, actor) and rollback-by-source; physical tenant isolation bounds the blast radius. |
| **LLM05** Improper Output Handling | #8 | I8 | A mandatory per-fragment output bound on every response path, plus the optional host `redactOutput` DLP seam (below). |
| **LLM06** Excessive Agency | #12 | I7 | Least agency by default: the registry is default-deny, `authorizeTool` denies unless wired, and every call is scoped, argument-validated and audited. Agency is bounded by construction — mutating (`action`) tools are refused outright behind a kill-switch, so today the model can read but never write; and the loop is capped in rounds, calls per round, calls per request, per-tool timeout, and concurrent loops per tenant. See [AI tools](/guides/satellites/ai-tools). |
| **LLM07** System Prompt Leakage | #8 | I4, I8 | The system prompt carries no secret, key, or tenant data (authorization lives in code, not the prompt); output handling never discloses it. |
| **LLM08** Vector & Embedding Weaknesses | #3, #16, #18 | I1 | Physically tenant-scoped vectors via `tableLocation` + ContextSeal + `guard.ai_scope_mismatch`; `rowscope-pg` refused; a per-plan `embeddingCount` quota. |
| **LLM09** Misinformation | #9 | — | Cross-tenant leakage is 0 by construction (I4); the residual is model hallucination, a quality risk, not isolation. Documented as an honest limit. |
| **LLM10** Unbounded Consumption | #2, #13 | I3 | Fail-closed `aiTokens` reserve/settle, an operator ceiling, a per-key request rate limit, and prompt/context bounds. |

### LLM05: improper output handling

Every streamed response passes a mandatory per-fragment output bound (I8), so no
single fragment can exceed the byte cap. On that floor, a host may wire
`config.ai.redactOutput` to redact or transform the model's output as a DLP policy
(strip PII, enforce a channel's content rules). It composes AFTER the mandatory
bound, so the bound always holds, and it is host-owned defense-in-depth, **never the
isolation control** (I4 is what makes cross-tenant leakage impossible, not a regex
over the output). A redactor that throws or returns a non-string fails closed (the
stream aborts, no un-redacted bytes), and because it runs at the single fragment
choke point, the redacted bytes are also what the idempotency cache and conversation
memory store. It is sync and per-fragment, so a pattern split across two fragments
can be missed. See [Redact model output](/guides/satellites/ai#redact-model-output)
for the how-to.

## Fail-closed postures and acknowledgements

Every security-relevant decision in the satellite fails closed: the route mount
refuses without a membership gate (**G4**), retrieval refuses without a document
ACL (**G2**), the audit write fails the request rather than succeeding silently
(I5), and a residency-denied egress is a 403 before any spend (#7/#15). None of
these degrade to a permissive default.

Where a fail-closed default would block a legitimate deployment, the satellite
offers an explicit acknowledgement instead of a silent opt-out. An
acknowledgement is a conscious, recorded decision: it names the risk you accept,
and it stays visible.

| Flag | Risk you accept |
|---|---|
| `acknowledgeNoMembershipGate` | Mount AI routes with no membership gate, so every authenticated caller can reach the tenant-scoped, cost-bearing endpoints. Only legitimate when membership is genuinely enforced elsewhere |
| `acknowledgeUnbudgetedAiTokens` | Run the endpoint unmetered (no per-plan `aiTokens` limit and no `operatorCeiling`), which is a denial-of-wallet exposure on a shared provider account |
| `acknowledgeUnscopedRetrieval` | Retrieval runs tenant-wide, so every user of a tenant retrieves that tenant's whole corpus. Tenant isolation still holds; the per-user document ACL is what you are waiving |

<Callout type="warning" title="An acknowledgement is visible, not silent">
Each acknowledgement logs a boot warning and keeps reporting through its doctor
check (`ai_membership_gate`, `ai_budget`, `ai_retrieval_gate`). The check never
stops flagging the posture, so an acknowledged risk stays on the operator's
dashboard rather than disappearing. Wire the real gate whenever you can; reach
for the acknowledgement only when the control genuinely lives elsewhere.
</Callout>

## Honest limits

A threat model that hides its edges is not trustworthy. These residuals are
mitigated but not eliminated, so decide how you bound each one.

- **A superuser can still `DROP` the audit table or its triggers.** The triggers
  stop `UPDATE`/`DELETE`/`TRUNCATE` for every role, and the hash chain plus the
  external anchor make tampering detectable off-box, but they do not stop a
  superuser from dropping the objects. Serve requests under a least-privilege
  role; the `ai_audit` doctor check warns when the app role is a superuser.
- **Hallucination is a quality risk, not isolation leakage.** The model can
  invent plausible, wrong content. Leakage of another tenant's real data is 0 by
  construction (it is never in the context); the residual is the model making
  something up. Grounding and citations reduce it but do not eliminate it.
- **The first-token streaming window.** Per-chunk validation reduces but cannot
  fully eliminate the window before the first fragment is validated. The real
  guarantee is I4 plus a secret-free system prompt, not the fragment check.
- **`redactOutput` is defense-in-depth, not a boundary.** The optional host
  output-redaction hook (LLM05) is sync and per-fragment, so it can miss a pattern
  split across two fragments, and it is never the isolation control: I4 (tenant-pure
  context) and the mandatory I8 output bound are the guarantee. A redactor that
  throws or returns a non-string fails closed (the stream aborts, no un-redacted
  bytes reach the client, cache, or memory).
- **Provider SDKs and endpoints are in the trust boundary.** A compromised
  provider sees all content sent through it. Pinning and auditing reduce, but do
  not remove, that trust; the residency allow-list is how you bound where content
  may egress at all.
- **A uniform 403 is a deterministic property, not a timing guarantee.** The
  satellite returns the same 403 for a non-existent and an unauthorized tenant,
  and uses `timingSafeEqual` on the security-sensitive comparisons, but it does
  not claim constant-time behavior across the whole request path.

## Observability: guards, doctor checks, metrics

### Guard events

Every fail-closed refusal emits the kernel's public `IsthmusGuardTripped` event
before it throws, with a `guard.ai_*` id inside the documented Isthmus taxonomy.
Subscribe once and both kernel and satellite trips arrive on the same channel:

```ts
// start/events.ts
import { IsthmusGuardTripped } from '@adonisjs-lasagna/saas-tenancy/events'

emitter.on(IsthmusGuardTripped, ({ payload }) => {
  if (payload.id.startsWith('guard.ai_')) {
    alerting.notify(payload.severity, payload.event, payload.tenantId)
  }
})
```

The satellite ships 18 guards. Severity is the triage signal: `critical` is a
would-be cross-tenant leak that was refused, `high` is a capability or
authorization boundary, `warn` is a control that trips in normal operation and is
watched by rate rather than per event.

| Guard id | Severity | Trips when |
|---|---|---|
| `guard.ai_scope_mismatch` | critical | A vector-store call's request tenant differs from the active tenancy scope (raw SQL bypasses the kernel ContextSeal; the store re-asserts) |
| `guard.ai_provider_allowlist` | high | A provider is resolved outside the tenant's default-deny allow-list (G12) |
| `guard.ai_model_allowlist` | high | A request names a model outside the per-provider allow-list (G12) |
| `guard.ai_route_mount` | high | AI routes are mounted without a middleware chain or membership gate (G4, at boot) |
| `guard.ai_streaming_capability` | high | A non-streaming provider is registered, which would break mid-stream cost control (at boot) |
| `guard.ai_memory_session_invalid` | high | A supplied `sessionId`'s MAC does not verify against the current principal (G6 hijack/pre-seed) |
| `guard.ai_residency_denied` | high | A provider or embedding backend is outside the tenant's residency allow-list (#7/#15) |
| `guard.ai_auto_purge_failed` | high | A tenant-lifecycle auto-purge (on `TenantDeleted`/`TenantAnonymized`) failed |
| `guard.ai_access` | warn | The membership gate denied a caller |
| `guard.ai_idempotency_key` | warn | The `Idempotency-Key` header is unbounded or non-printable |
| `guard.ai_config_invalid` | warn | The `config.ai` block is malformed (at boot) |
| `guard.ai_rate_limited` | warn | The per-key request rate limit was exceeded (#4, denial of wallet) |
| `guard.ai_rowscope_refused` | warn | Embeddings were requested on `rowscope-pg`, the weakest placement (I1) |
| `guard.ai_dimension_mismatch` | warn | An embedding's length does not match the migrated `vector(N)` dimension |
| `guard.ai_embedding_quota_exhausted` | warn | The per-plan `embeddingCount` cap was hit (#18) |
| `guard.ai_ingestion_denied` | warn | The `authorizeIngestion` write gate denied a caller |
| `guard.ai_retrieval_denied` | warn | The `retrievalFilter` document ACL denied, or is absent and unacknowledged (G2) |
| `guard.ai_audit_write_failed` | warn | An append-only audit row could not be written (I5 fail-closed) |

AI trips are counted per tenant on the `ai_guard_rejections` metric. They do not
appear in the kernel's `multitenancy_isthmus_*` Prometheus counters, which render
kernel guards only. See the [Isthmus reference](/reference/isthmus) for the
taxonomy and budget semantics.

### Doctor checks

`tenant:doctor` surfaces every AI posture. Run it on a cron and page on
`error`-level findings.

| Check | What it reports |
|---|---|
| `ai_membership_gate` | Whether `authorizeAIAccess` is wired, acknowledged, or in a default-deny state |
| `ai_budget` | The `aiTokens` metering posture (per-plan budget, operator ceiling, dynamic, or an unbudgeted denial-of-wallet exposure) |
| `ai_retrieval_gate` | The retrieval document-ACL posture (`retrievalFilter` wired, acknowledged tenant-wide, or fail-closed) |
| `ai_audit` | That `backoffice.ai_audit_logs` exists and the app role is not a superuser |
| `ai_memory` | The conversation-memory principal posture (enabled-but-no-principal memory is inert) |
| `ai_compliance` | Redis reachability for the memory and cache-epoch purge, plus a `keyPrefix` confirmation (read-only, never bumps the epoch) |
| `pgvector_extension` | That the `vector` extension is installed in the dedicated `extensions` schema (which schema-pg tenant connections append to their `search_path`) where the tenant's data resolves it, and the app role is not a superuser (G14) |

### Metrics

Every AI metric is a content-free counter: no prompt, response, key, query, or
document text ever reaches telemetry. The stream emits `ai_requests`,
`ai_tokens_total`, `ai_errors`, `ai_stream_disconnects`; retrieval adds
`ai_retrieval_tokens_total`, `ai_retrieval_matches`, `ai_retrieval_errors`;
memory adds `ai_memory_unreadable`, `ai_memory_persist_failed`,
`ai_memory_decrypt_previous_used`, `ai_memory_undecryptable`; compliance adds the
`ai_purge_*` family and `ai_auto_purge_failures`; an optional `redactOutput` hook
adds `ai_output_redacted` (how many output fragments it changed or aborted); and
guard trips roll up on `ai_guard_rejections`.

<Callout type="tip" title="The two metrics that mean 'act now'">
`ai_memory_undecryptable` climbing usually means an `APP_KEY` rotation went past
the `OLD_APP_KEY` grace window, so stored memory is being silently dropped.
`ai_auto_purge_failures` climbing means a GDPR erasure on tenant delete/anonymize
did not complete. Neither is visible in the request path, so alert on both.
</Callout>

## Operations

**A retrieval store outage returns a non-2xx.** If the vector store is
unreachable during a `/ai/retrieve` (or a RAG-into-chat retrieve), the request
currently fails with a 500 and the cost reservation is released. A PostgreSQL
error carries no tenant data, and `AIException.message` is log-safe, so this does
not leak content unless the host's exception handler echoes a raw pg message
(standard production handlers do not). Operationally: monitor `ai_retrieval_errors`
and page on a spike, which is the signal for a store outage or a saturated pool.

**Verify the audit chain on a schedule.** The per-tenant hash chain is only
useful if you check it. Run it as a cron and on-demand after any incident:

```bash
node ace tenant:ai:audit:verify              # every tenant; exit 1 on the first break
node ace tenant:ai:audit:verify --tenant=<id> --json
```

**Erase on request.** GDPR erasure composes the purge seams (cache epoch, then
memory, then embeddings) with an honest per-step summary:

```bash
node ace tenant:ai:purge --tenant=<id> --principal=<userId>   # one user, Art.17
node ace tenant:ai:purge --tenant=<id> --force                # the whole tenant
node ace tenant:ai:purge --tenant=<id> --principal=<userId> --dry-run
```

The immutable, non-PII audit chain survives a purge by design (G1); there is no
content in it to erase. See the AI guide's [Audit](/guides/satellites/ai#audit)
and [Compliance](/guides/compliance) for the full contract.

## AI hardening checklist for production

Every item is a host decision; the satellite gives you the primitive and fails
closed until you make the call.

- [ ] `authorizeAIAccess` wired (or `acknowledgeNoMembershipGate: true` recorded) so only members can stream on a tenant's behalf.
- [ ] `retrievalFilter` wired for per-user document scope (or `acknowledgeUnscopedRetrieval: true` recorded), if you use retrieval.
- [ ] `aiTokens` budgeted per plan **and** an `operatorCeiling` set (or `acknowledgeUnbudgetedAiTokens: true` recorded), so a runaway tenant cannot drain the account.
- [ ] `config.ai.rateLimit` set to cap requests-per-window per tenant-key.
- [ ] The app database role is **not** a superuser or `BYPASSRLS` (so it cannot drop the audit table), verified by the `ai_audit` and `pgvector_extension` doctor checks.
- [ ] `node ace tenant:vector:provision` run so the `vector` extension exists where each tenant's data lives, if you use embeddings.
- [ ] `config.ai.residency` set if a tenant's prompts or documents must stay on an allow-listed provider or local-only.
- [ ] `config.ai.redactOutput` wired if a channel needs output redaction / DLP (host-owned defense-in-depth, never the isolation control; alert on the `ai_output_redacted` metric).
- [ ] `node ace tenant:ai:audit:verify` on a cron, paging on a non-zero exit.
- [ ] `Access-Control-Expose-Headers: X-Ai-Session` set for browser clients, if you use conversation memory.
- [ ] `OLD_APP_KEY` kept in the environment across an `APP_KEY` rotation so memory decrypts through the grace window.
- [ ] Alerting subscribed to `guard.ai_*` trips and to the `ai_memory_undecryptable` and `ai_auto_purge_failures` metrics.

If you use [tools](/guides/satellites/ai-tools), add:

- [ ] `authorizeTool` wired (or `acknowledgeUnauthorizedTools: true` recorded), so a tool call is authorized per caller and per tool rather than merely resolved. The `ai_tools` doctor check warns until you make the call.
- [ ] `config.ai.tools.actionTools` left disabled unless you have read the [action-tool posture](/guides/satellites/ai-tools#action-tools-mutating). Mutating tools are refused today; enabling the flag does not turn writes on, it only records the intent.
- [ ] Each tool's `inputSchema` declares every argument it accepts, since the validator rebuilds arguments from that whitelist — an argument you forget to declare never reaches the handler.
- [ ] `maxConcurrentPerTenant` reviewed against your connection pool, and — for high-concurrency or action deployments — `isolation.enforceConnectionCap` enabled so a cross-tenant flood cannot exhaust it.
- [ ] Alerting subscribed to the `ai_tool_denied` and `ai_tool_budget_exhausted` metrics: a rising denial rate is either a misconfigured authorizer or someone probing the registry.

## Read next

- [AI tools](/guides/satellites/ai-tools) — the authoring guide for vector #12 / I7: registry, authorization, bounds, and the action-tool posture.
- [AI satellite](/guides/satellites/ai) — the how-to for config, routes, and every feature referenced here.
- [Security](/guides/security) — the kernel's guarantees, the host's responsibilities, and the vulnerability-reporting process (which covers this satellite too).
- [Isthmus guard registry](/reference/isthmus) — the guard taxonomy, severities, and budget semantics the `guard.ai_*` ids ride on.
- [Compliance (SOC2 & GDPR)](/guides/compliance) — how erasure and residency map to GDPR controls.
