# 03 Injection defense: structural signal + pluggable classifier seam (Wave 3)

Wave 3 does two things and refuses a third. It makes the structural prompt-injection boundary that already ships OBSERVABLE (a forgery attempt becomes a named signal instead of a silent rewrite), and it adds an `InjectionClassifier` async host contract as a defense-in-depth seam on the INPUT side. It deliberately does NOT ship a hardwired semantic regex wall as the boundary, because the boundary is structural role separation and a regex ruleset masquerading as protection is exactly the theater the governing direction (`00-foundation.md` section 1) rejects. The whole wave is built so the classifier composes with the structural boundary and can never become it.

## 1. What already ships

The structural defense is real, deterministic, and covered. Two mechanisms carry it.

The client-facing grammar in `parseChatBody` (`ai_chat_controller.ts:980-1057`) admits only the three roles in `MESSAGE_ROLES` (`ai_chat_controller.ts:960`, `system|user|assistant`) and reads only the `role` and `content` keys off each entry (`ai_chat_controller.ts:994-1003`). A client literally cannot submit an `assistant.toolCalls` turn or a `role:'tool'` result: every tool turn is server-authored mid-loop. A malformed turn routes through `invalid()` (`ai_chat_controller.ts:963-965`), which throws `AIException('invalid_request')`. This role/key grammar IS deterministic structural detection: a forged-tool-result or confused-deputy turn is rejected by construction, not by a heuristic.

The fence neutralization is the second layer. `neutralizeFence` (`context_builder.ts:76-78`) case-insensitively rewrites the `retrieved_context` token (`context_builder.ts:10`) inside every retrieved document so a doc cannot forge a `</retrieved_context>` and break out of its data block, and `buildRetrievalContext` returns the block as a `user` turn always (`context_builder.ts:65`), never a trusted instruction turn. `neutralizeToolFence` (`tool_executor.ts:518-520`) does the same for the `tool_result` fence on every tool result. The `PREAMBLE` (`context_builder.ts:20-23`) frames the fenced blocks as untrusted DATA. As both docstrings state, the fence and preamble are defense-in-depth framing; the real control is role separation plus invariant I4 (nothing cross-tenant is ever in the context, pinned by `check-ai-invariant-4`, see `00-foundation.md` section 2).

The honest gap in this baseline: the neutralization is SILENT. When a retrieved document or a tool result actually contains a fence-token forgery attempt, `neutralizeFence` rewrites it and moves on. Nobody can see that a breakout was attempted and defeated. There is no signal, no metric, no guard.

## 2. The gap

Two concrete gaps, one observability and one coverage.

First, the structural boundary is invisible in operation. A fleet of retrieved documents probing for a fence breakout looks identical, in every counter and log, to a corpus that never tried. An operator running an incident cannot answer "is something injecting fence forgeries into my RAG corpus" from any telemetry the satellite emits, because the defense that defeats it emits nothing (`context_builder.ts:76-78`, `tool_executor.ts:518-520`). The defense works; it is just mute.

Second, the structural layer by design does not read prose. `neutralizeFence`'s own docstring says scrubbing a document's wording for "instructions" would be the regex theater the design rejects, so it deliberately leaves prose intact (`context_builder.ts:73-77`). That is the correct call for a built-in, but it means a host with a genuine semantic-detection policy (a corporate classifier, a hosted moderation endpoint, a fine-tuned guard model) has no seam to plug it into. The satellite offers `redactOutput` for the OUTPUT side (`define_config.ts:217-221`) but nothing symmetric for the INPUT side.

## 3. The root-cause mitigation

### 3a. Make the structural boundary observable (neutralize AND observe, never block)

Register `guard.ai_injection_structural` in `AI_GUARD_REGISTRY` (`ai_guard_registry.ts:60-493`) and emit it via `emitAiGuardEvent` (`ai_guard_audit.ts:72`) on the line where `neutralizeFence` / `neutralizeToolFence` actually rewrite a token (only when a rewrite occurred, so the signal means "a forgery was attempted and neutralized," not "a document passed through"). The neutralization behavior is UNCHANGED: the token is still rewritten, the request still proceeds. This is the one AI guard whose posture is "neutralize and observe" rather than "reject," a deliberate and documented divergence from the registry's usual reject-semantics that the evidence field must state plainly. Its `failMode` is `'closed'` because the breakout is structurally closed by the neutralization plus role separation regardless of whether the signal fires; the emission is pure observability layered on an already-closed boundary. Its `severity` is `'warn'`, matching the `ai_rate_limited` / `ai_tool_confirmation_unmatched` posture (`ai_guard_registry.ts:174-188`, `462-476`): fence forgeries appear in ordinary operation (a document that legitimately contains the substring), so this is monitored by rate, not treated as per-event intrusion.

Because it is a neutralize-and-observe signal and not a rejection, it gets its OWN dedicated per-tenant counter, a named constant `AI_INJECTION_STRUCTURAL_METRIC = 'ai_injection_structural'` in `constants.ts`, rather than inflating the shared `ai_guard_rejections` bridge (`ai_guard_audit.ts:31`) with events that are not rejections. This mirrors the existing pattern where a guard carries a dedicated content-free counter alongside the shared bridge (`AI_OUTPUT_REDACTED_METRIC`, `constants.ts:77`, is exactly this: a count, never the text). Adding the guard follows the fixed four-step act from `00-foundation.md` section 2 (registry literal, `emitAiGuardEvent` before the neutralizing rewrite, an emission recipe in the emission-matrix spec, keep `no_silent_ai_guard` green).

### 3b. The `InjectionClassifier` async host contract (the seam)

Add to `AiConfig` (`define_config.ts`, alongside `redactOutput` at `:491` and `residency` at `:483`) an optional `injection` block:

```ts
export interface InjectionVerdict {
  readonly action: 'allow' | 'block'
  readonly reason?: string   // short, log-safe; never echoed to the client
}

export type InjectionClassifier = (
  ctx: HttpContext,
  tenant: TenantModelContract,
  input: { readonly text: string; readonly origin: 'user' | 'retrieved' | 'tool' }
) => InjectionVerdict | Promise<InjectionVerdict>

export interface AIInjectionConfig {
  classifier?: InjectionClassifier
  /** Fail posture when the classifier itself throws or returns a malformed verdict. Default 'open'. */
  onError?: 'open' | 'closed'
  /** Also run the classifier over the assembled retrieved-context block. Default false (opt-in). */
  scanRetrieved?: boolean
}
```

This mirrors the shape-(a) seam pattern the codebase already uses for `RetrievalFilter` (`define_config.ts:107-110`), `AIToolAuthorizer` (`define_config.ts:307-311`), and `RedactOutput` (`define_config.ts:217-221`): a host-supplied function, boot-validated for its type, request-time consumed behind a fail-posture wrapper.

**Boot validation.** Add `assertInjectionConfig(config.injection)` to `assertAiConfig` (called next to `assertRetrievalConfig` at `validate_config.ts:126`), modeled on `assertRetrievalConfig` (`validate_config.ts:271-284`). It routes every branch through `fail()` (`validate_config.ts:40-45`, the single choke that emits `guard.ai_config_invalid`): `classifier`, when set, must be a function (the `typeof === 'function'` idiom used for `redactOutput` at `validate_config.ts:107-111` and `retrievalFilter` at `validate_config.ts:276-278`); `onError`, when set, must be `'open'` or `'closed'`; `scanRetrieved`, when set, must be a boolean. Boot validation never inspects the classifier's RETURN value; the return-shape guarantee is the request-time gate, per discipline point 4 in `00-foundation.md`.

**Where it runs, and why async is free here.** The consumer sits at the input pre-flight choke point in `chat()`, after `parseChatBody` (`ai_chat_controller.ts:176`) and BEFORE the reserve inside the streaming spine (the sequence at `ai_chat_controller.ts:168-199` puts authorization and validation ahead of any cost). It classifies each `user` turn's content with `origin:'user'`, and, only when `scanRetrieved` is on, the assembled retrieval block from `buildRetrievalContext` with `origin:'retrieved'`. Because it runs on INPUT, before the provider call and before the first streamed byte, it can be `async` at zero streaming-latency cost. This is the deliberate contrast with `RedactOutput`, which is SYNC and per-fragment precisely because "async per-token DLP would kill streaming latency" (`define_config.ts:210-215`). Input detection has no such constraint: the latency it adds is one-time, pre-stream, and paid before any spend.

### 3c. Fail posture, split by role in the design

This is the subtle heart of the wave and it inverts the usual discipline for a stated reason.

On a **block verdict**, the mitigation is fail-CLOSED. A new `injection_detected` code joins `AI_ERROR_CODES` (`ai_exception.ts:9-45`) with status 400 in `STATUS_BY_CODE` (`ai_exception.ts:55-108`, a forged/manipulated input is a permanent client fault, like `invalid_request` at `:63`), and it is classified FATAL in the Wave-0 compile-forced RETRYABILITY map (today the hand-maintained `FATAL_CODES` Set at `ai_exception.ts:128-178`, whose own comment at `:148` flags the drift hazard Wave 0 removes). A blocked request never becomes correct on a retry of the identical input, so retrying it must be refused. The block emits `guard.ai_injection_detected` (registered, `failMode:'closed'`, `severity:'high'`, the four-step act) and a dedicated `AI_INJECTION_DETECTED_METRIC = 'ai_injection_detected'` counter. The audit outcome is `failed_preflight` (the preflight record shape at `audit_seam.ts:54`) with ZERO spend, because the reject fires before the reserve.

On the **classifier's own error** (a throw, or a return that is not a well-formed `InjectionVerdict`), the default is fail-OPEN. This is the exception to the "seams fail closed" pattern that `RetrievalFilter`, `AIToolAuthorizer`, and `RedactOutput` all follow, and the reason is structural, not a shortcut. Those seams ARE the boundary for their concern: `RetrievalFilter` is the document ACL, so its failure must deny or a leak follows; `RedactOutput` gates the output bytes, so its failure must abort or unredacted bytes ship. The `InjectionClassifier` is NOT the boundary. The boundary is structural role separation plus I4, and that boundary holds whether the classifier ran, passed, failed, or was never configured. An input-detector error therefore cannot cause a cross-tenant leak: there is nothing for it to fail open INTO. Denying every request when a host's moderation endpoint has a bad minute would be pure availability damage for zero security gain. So the default `onError:'open'` emits `AI_INJECTION_DETECTOR_ERROR_METRIC = 'ai_injection_detector_error'` and proceeds. A host whose threat model wants the stricter posture sets `onError:'closed'` and takes the availability coupling knowingly, exactly the visible-opt-out shape of `acknowledgeUnscopedRetrieval` (`00-foundation.md` discipline point 7). The fail-open wrapper is a property of the seam's policy, set explicitly, not a caller who forgot a `try/catch` (`00-foundation.md` section 1).

No new numeric bound is introduced. The classified text is already bounded by the existing `DEFAULT_AI_MAX_PROMPT_CHARS` (`parseChatBody`, `ai_chat_controller.ts:1005-1008`) for user input and `DEFAULT_MAX_CONTEXT_CHARS` for the retrieval block (`define_config.ts:131`), so there is no inline literal and no `MAX_*` to add.

### 3d. No semantic ruleset ships as the boundary

The package ships the seam (3b) and the structural built-in (3a). It does NOT wire a bundled English-pattern-family regex classifier as a default boundary. Such a default would be theater: it catches the naive "ignore previous instructions" string, misses paraphrase, encoding, and every non-English variant, and its mere presence invites an operator to believe injection is "handled." That contradicts the codebase's stance that `neutralizeFence` refuses to scrub prose for "instructions" precisely because it would be regex theater (`context_builder.ts:73-77`). An info-only doctor check, `ai_injection_check.ts`, reports the posture instead, modeled on `ai_retrieval_gate_check.ts` (`ai_retrieval_gate_check.ts:65-78`, the `DoctorCheck` / `DiagnosisIssue` shape): it emits an `info` issue naming whether a `classifier` is wired, whether `scanRetrieved` is on, and the `onError` posture, so the accepted state stays on the operator's radar without failing a diagnosis run. Reporting the posture is the honest move; wiring a fake wall is not.

## 4. Acceptance tests

Red-first, each stating the gap before the fix, per `00-foundation.md` discipline point 1.

1. **Structural signal, behavior preserved.** A user turn (and, separately, a retrieved document and a tool result) carrying a `</retrieved_context>` or `</tool_result>` forgery. Assert the token is still neutralized (the existing behavior stays green, proving 3a did not change the boundary) AND that `guard.ai_injection_structural` fired with `AI_INJECTION_STRUCTURAL_METRIC` bumped. An emission-matrix recipe entry for the guard, keeping `no_silent_ai_guard` green.
2. **Block verdict.** A stub classifier returning `{action:'block'}`. Assert the request fails with `injection_detected` (400), `guard.ai_injection_detected` fired, `AI_INJECTION_DETECTED_METRIC` bumped, audit outcome `failed_preflight`, and NO reserve occurred (zero spend). A retryability spec pins `injection_detected` as fatal in the compile-forced RETRYABILITY map (the Wave-0 successor to `FATAL_CODES`, `ai_exception.ts:128-178`).
3. **Detector error fail-open (default) and fail-closed (opt-in).** A throwing classifier: with `onError` absent/`'open'`, the request PROCEEDS and `AI_INJECTION_DETECTOR_ERROR_METRIC` fires; with `onError:'closed'`, it is refused. Both branches assert no cross-tenant content ever appears.
4. **The load-bearing invariant: the boundary was never the classifier.** With the entire `injection` block ABSENT, the existing cross-tenant isolation spec (the I4 / cross-tenant fuzz coverage referenced in `00-foundation.md` section 2) still shows leakage 0. This is the spec that proves the classifier is defense-in-depth, not the isolation control: turning it off changes zero about tenant separation.
5. **Boot validation.** A non-function `classifier`, an `onError` outside `{'open','closed'}`, and a non-boolean `scanRetrieved` each abort boot through `fail()` (`validate_config.ts:40-45`), emitting `guard.ai_config_invalid`.
6. **Doctor posture.** `ai_injection_check.ts` reports `info` for each posture (no classifier / classifier wired / `scanRetrieved` on) without failing a run, mirroring `aiRetrievalGateCheck` (`ai_retrieval_gate_check.ts:65-78`).

## Honesty bound

- This does not make the AI satellite "prompt-injection-proof" or "unhackable." The structural signal (3a) observes only fence and delimiter forgery, the one thing the structural layer already defeats. It does not read prose and detects nothing semantic, by design.
- The `InjectionClassifier` is optional, host-supplied, and overridable. Whatever a host plugs in can be evaded: paraphrase, base64 or unicode encoding, multilingual phrasing, and payloads split across turns all defeat pattern-based classifiers, and even a model-based classifier has a false-negative rate. A green verdict is not a safety proof.
- The default `onError:'open'` means a classifier outage lets input through. That is a deliberate availability choice justified only because the classifier is NOT the boundary; it is not a claim that input was inspected.
- No semantic ruleset ships as the boundary. The boundary remains structural role separation plus I4 (`00-foundation.md` section 2). The structural signal is observability and the classifier is defense-in-depth; neither is the isolation control, and a host must not treat either as one.
- A `block` verdict refuses a request; it does not, and cannot, prove the refused input was actually malicious. False positives are the operator's tuning problem, surfaced by `AI_INJECTION_DETECTED_METRIC`.

## Open decisions owned by the user

1. **Semantic default (recommended: seam-only).** Ship the seam and the structural built-in, no bundled classifier, the `ai_injection_check.ts` posture check reporting the state. This matches the executed plan and the `00-foundation.md` no-theater stance. The alternative, an optional, clearly-labeled, fully-overridable reference classifier that is NEVER the boundary and is off by default, is available if a host explicitly wants a starting point, but the recommendation is not to ship it, because its presence tempts operators to trust it.
2. **Detector error posture (recommended: `onError:'open'`).** Fail-open on a classifier error, because an input detector is not the boundary and denying on its outage is availability damage for no security gain. A host whose policy prefers the stricter coupling sets `onError:'closed'` and accepts that a moderation-endpoint outage refuses traffic.
3. **Retrieved-context scanning (recommended: `scanRetrieved:false`).** Leave classifier scanning of the assembled retrieval block opt-in. The structural fence + `user`-role separation (`context_builder.ts:65`, `76-78`) already contains retrieved content as data; a host that additionally wants its semantic classifier over the RAG block sets `scanRetrieved:true` and pays the extra pre-stream latency.
